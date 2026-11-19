// Etapa 6 (a pesquisa no cérebro e os ajustes da Liz na etapa 5) por partes, num processo só (docs/RELATORIO_ETAPA6_PESQUISA.md):
//  A. limites de tokens por provedor (core/ai/limitesTokens.js): configuração, capacidade e teto global; o roteador do Gateway manda a cada
//     provedor o limite DELE; o AI Manager só faz isso com `tokensPorProvedor` (o cérebro); a tabela do bot é a mesma (uma fonte só);
//  B. a pesquisa no cérebro (src/cerebro/pesquisa.js + conversa.js): research.turn (pública, privada, recusas, ramo antigo), a busca automática
//     do passo, o /yui inteiro (chat.yui), o isolamento entre o Braga em DM e um membro no servidor AO MESMO TEMPO, o progresso só para a
//     chave do pedido, e o turno com pesquisa fora do contexto por horas;
//  C. falhas e reconexões com o CANAL DE VERDADE (servidor + cliente + um "cabo" TCP que o teste corta): a conexão cai no meio da pesquisa e
//     a repetição com a mesma chave NÃO busca de novo; o prazo do passo estoura: um aviso só, nenhuma chamada paralela à IA, nenhuma segunda
//     resposta, e a repetição posterior com a mesma chave devolve o resultado guardado; o commit pendente é reconciliado depois (A5);
//  D. o JSON de ferramenta do cérebro é um PEDIDO, não uma autorização (A4): o guardToolCall nega em enforce; ferramenta desligada no servidor,
//     voz e anexo continuam barrados no bot;
//  E. o "Processando..." guardado (A3): gravação atômica, prazo, estados, e a recuperação depois de um reinício (edita só o que confere).
// SEM rede (axios e fetch bloqueados; buscadores e IA falsos), SEM Discord, SEM bancos reais (pasta temporária).
// Execução: npm run test:pesquisaunidade   (node tests/test-pesquisa-cerebro-unidade.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-pesquisa-unidade-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const GUILD_OFF = '888888888888888882';
const REGISTRO = path.join(tmp, 'buscas.jsonl');
const BUSCA_CTRL = path.join(tmp, 'busca-controle.json');
const AUDIT = path.join(tmp, 'audit.jsonl');

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'off',
  YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', YUI_QUEUE_MAX_PER_USER: '20', YUI_CHAT_ESPERA_CEREBRO_MS: '8000',
  YUI_CHANNEL_SECRET_FILE: path.join(tmp, 'secrets', 'channel-secret.json'), YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890', YUI_POLICY_MODE: 'observe',
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_VOICE_TOOLS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO', 'YUI_CHAT_TURN_TIMEOUT_MS', 'YUI_HISTORY_MAX_CHANNELS', 'YUI_REPLY_MAX_TOKENS',
  'YUI_CEREBRO_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO', 'YUI_CEREBRO_BUSCA_AUTOMATICA', 'YUI_READ_ONLY', 'AI_MAX_TOKENS', 'YUI_GATEWAY_DISABLE', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
axios.post = async () => { throw new Error('offline (teste)'); };
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
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const llm = await imp('src/handlers/llmHandler.js');
const conversa = await imp('src/cerebro/conversa.js');
const pesquisa = await imp('src/cerebro/pesquisa.js');
const turno = await imp('src/discord/turnoCerebro.js');
const limites = await imp('src/core/ai/limitesTokens.js');
const manager = await imp('src/core/ai/manager.js');
const gatewayIndex = await imp('src/gateway/index.js');
const { createRouter } = await imp('src/gateway/router.js');
const { createFakeSearch } = await imp('src/cerebro/buscaFalsa.js');
const { createIdemCache } = await imp('src/core/channel/protocol.js');
const { startChannelServer } = await imp('src/core/channel/server.js');
const { connectChannel } = await imp('src/core/channel/client.js');
const processando = await imp('src/discord/processandoGuardado.js');
const policy = await imp('src/core/security/policyEngine.js');
const { VOICE_TOOL_REFUSAL } = await imp('src/services/tts/voiceGuards.js');
const { SENSITIVE_SEARCH_REFUSAL, SEARCH_DISABLED_REPLY, VOICE_REFUSAL } = await imp('src/core/ai/searchIntent.js');

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
let idSeq = 940000000000000000n;
const nextId = () => String(++idSeq);
const tokensOf = (text) => [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
const registro = () => { try { return fs.readFileSync(REGISTRO, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const limparRegistro = () => { try { fs.rmSync(REGISTRO, { force: true }); } catch { /* */ } };
const buscaControle = (c) => realWrite(BUSCA_CTRL, JSON.stringify(c));
buscaControle({});
const busca = createFakeSearch({ env: { YUI_TESTE_BUSCA_FALSA_REGISTRO: REGISTRO, YUI_TESTE_BUSCA_FALSA_CONTROLE: BUSCA_CTRL } });

/**
 * IA falsa do teste: o otimizador da busca responde "SIM: <entrada>", a síntese da pesquisa responde com as marcas do que recebeu, e a
 * conversa responde `reply(a)` (padrão: um texto com as marcas). Guarda todas as chamadas (com `tipo`).
 */
function fakeAi({ reply = null, delayMs = 0 } = {}) {
  const calls = [];
  const answer = async (a, isolated) => {
    const sys = String(a.system ?? '');
    const prompt = String(a.prompt ?? '');
    let tipo = 'conversa';
    if (sys === 'Responda apenas com o comando solicitado.') tipo = 'otimizador';
    else if (prompt.includes('[PERGUNTA DO USUÁRIO]:')) tipo = 'sintese';
    calls.push({ ...a, tipo, isolated });
    if (delayMs) await sleep(delayMs);
    if (tipo === 'otimizador') { const m = /ENTRADA: "([^"]*)"/.exec(prompt); return `SIM: ${m ? m[1] : 'consulta'}`; }
    if (tipo === 'sintese') return `Segundo as fontes [1], está tudo certo. marcas=[${tokensOf(prompt).join(',')}] sensivel=${a.sensitive === true ? 'sim' : 'nao'}`;
    if (typeof reply === 'function') return reply(a, calls.length);
    return `resposta da conversa marcas=[${tokensOf(prompt).join(',')}] web=${prompt.includes('DADOS NÃO CONFIÁVEIS') || /\[DADOS? (?:DA WEB|NÃO CONFIÁVEIS)/i.test(prompt) ? 'sim' : 'nao'}`;
  };
  return {
    calls,
    listBackends: () => [{ name: 'falsa', active: true }],
    chat: (a) => answer(a, false),
    isolatedChat: (a) => answer(a, true),
  };
}
const ctxStore = await imp('src/core/context/contextStore.js');
const channelFacts = (guild, channel, user) => llm.channelFactsForCerebro({ guildId: guild, channelId: channel, userId: user });
function facts({ id = nextId(), user, guild = null, channel, text, call = {}, entry = 'fila' } = {}) {
  return {
    turn: { id, at: Date.now() - 500 },
    ctx: { platform: 'discord', userId: user, guildId: guild, channelId: channel, isDM: !guild, isBlocked: false },
    call: { entry, type: entry === 'yui' ? 'slash' : 'mention', record: true, mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false, ...call },
    ownText: text, memoryQuery: text, channel: channelFacts(guild, channel, user),
  };
}
function brains({ ai = fakeAi(), env = process.env, emit = () => 0 } = {}) {
  const chat = conversa.createChatBrain({ ai, logger: quiet, busca, env, memoryBlock: () => '', persona: () => '' });
  const research = pesquisa.createResearchBrain({ chat, ai, logger: quiet, busca, env, emit });
  return { chat, research, ai };
}

// ── Ajudantes da fila (Discord falso na memória) e do canal falso com o cache de idempotência DE VERDADE ──
function fakeChannel(chat, research) {
  const listeners = new Map();
  const stateListeners = new Set();
  const idem = createIdemCache();
  const ch = {
    connected: true, calls: [],
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev)?.delete(fn); },
    onState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    ready: async () => ({}),
    async request(method, params, { idem: key } = {}) {
      ch.calls.push({ method, idem: key });
      const meta = { ...META, idem: key ?? null };
      const exec = async () => {
        try {
          let payload;
          if (method === 'chat.turn') payload = await chat.turn(params, meta);
          else if (method === 'chat.commit') payload = await chat.commit(params, meta);
          else if (method === 'research.turn') payload = await research.turn(params, meta);
          else if (method === 'chat.yui') payload = await research.yui(params, meta);
          else if (method === 'chat.forgetVoice') payload = chat.forgetVoice(params);
          else return { ok: false, error: { code: 'METHOD_NOT_FOUND', message: '?' } };
          return { ok: true, payload };
        } catch (err) { return { ok: false, error: { code: err.code ?? 'ERRO', message: err.message } }; }
      };
      const out = key ? await idem.run(`bot\u0000${method}\u0000${key}`, exec).promise : await exec();
      if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
      return out.payload;
    },
    emit(ev, payload) { for (const fn of listeners.get(ev) ?? []) fn(payload); },
  };
  return ch;
}
let seq = 0;
function fakeMention({ userId, channelId, guildId, text, voice = false, attachment = null }) {
  const edits = [];
  const msg = {
    id: nextId(), createdTimestamp: Date.now() - 50, content: `<@900000000000000001> ${text}`, channelId, guildId, isVoice: voice,
    guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    author: { id: userId, tag: `u${userId.slice(-4)}#0001`, username: `u${userId.slice(-4)}`, bot: false }, client: { user: { id: '900000000000000001' } },
    mentions: { has: () => true, everyone: false, repliedUser: null, users: new Map() },
    channel: { id: channelId, name: 'geral', send: async (p) => { edits.push(p); return { id: `${++seq}`, channelId, async edit(q) { edits.push(q); }, async delete() {} }; } },
    edits, replies: [], attachment,
    async reply(opts) { this.replies.push(opts); return replyMsg; },
    get outputs() { return [...this.replies, ...this.edits]; },
  };
  const replyMsg = { id: `9${String(++seq).padStart(17, '0')}`, channelId, channel: msg.channel, async edit(p) { edits.push(p); return replyMsg; }, async delete() { return undefined; } };
  msg.replyMsg = replyMsg;
  return msg;
}
const isProgress = (c) => /Processando|Sua solicitação está na fila/.test(c);
const textOf = (p) => (typeof p === 'string' ? p : p?.content ?? '');
const finals = (m) => m.outputs.map(textOf).filter((c) => c && !isProgress(c));
const finalText = (m) => [...finals(m)].reverse()[0] ?? '';
async function ask(m, text, extra = {}) {
  await llm.addToQueue(`--- CONTEXTO ---\n--- MENSAGEM ATUAL ---\n${m.author.username}: "${text}"`, m, 'mention', { allowSearch: true, searchPrompt: text, guildId: m.guildId ?? undefined, ...extra });
}
async function waitFinal(m, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = finalText(m); if (t) return t; await sleep(25); }
  throw new Error('sem resposta final');
}
const toolJson = (tool, args) => JSON.stringify({ thought: 'acao', tool, args });
async function comCerebro(reply, fn) {
  const ai = fakeAi({ reply });
  const chat = conversa.createChatBrain({ ai, logger: quiet, busca, memoryBlock: () => '', persona: () => '' });
  const research = pesquisa.createResearchBrain({ chat, ai, logger: quiet, busca, emit: () => 0 });
  const ch = fakeChannel(chat, research);
  turno.setChatRemote(ch, { logger: quiet });
  try { await fn({ ai, ch }); } finally { await sleep(1300); turno.setChatRemote(null); }
}
const auditLines = () => { try { return fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. Limites de tokens por provedor (configuração, capacidade e teto global)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('padrões: os mesmos da cadeia do bot (uma fonte só), por provedor do Gateway', () => {
    const lim = (p, env = {}, cap = null) => limites.limiteDoProvedor(p, { env, capacidadeDeclarada: cap }).limite;
    assert.equal(lim('groq'), 1024);
    assert.equal(lim('gemini'), 2048);
    assert.equal(lim('huggingface'), 512);
    assert.equal(lim('cloudflare'), 1024);
    assert.equal(lim('pollinations'), 1024);
    assert.equal(lim('openrouter'), 1024, 'provedor fora da cadeia do bot: o padrão do "gateway" do bot');
    assert.equal(lim('meu-proprio', {}, 300), 300, 'capacidade declarada no YUI_GATEWAY_CUSTOM corta');
    const bot = llm.getProviderSettings();
    for (const [k, v] of Object.entries(limites.LIMITES_PADRAO_CADEIA)) assert.equal(bot[k].max_tokens, v, `a cadeia do bot usa a MESMA tabela (${k})`);
  });
  await test('YUI_REPLY_MAX_TOKENS sobe todos, mas a capacidade e o teto global cortam; YUI_CEREBRO_MAX_TOKENS por provedor vence', () => {
    const env = { YUI_REPLY_MAX_TOKENS: '6000' };
    assert.deepEqual(limites.limiteDoProvedor('groq', { env }).limite, 4096, 'cortado pelo teto global (padrão 4096)');
    assert.match(limites.limiteDoProvedor('groq', { env }).origem, /teto global/);
    assert.equal(limites.limiteDoProvedor('cloudflare', { env }).limite, 2048, 'cortado pela capacidade do provedor');
    assert.match(limites.limiteDoProvedor('cloudflare', { env }).origem, /capacidade/);
    assert.equal(limites.limiteDoProvedor('groq', { env: { ...env, YUI_MAX_TOKENS_TETO: '8192' } }).limite, 6000);
    const por = { YUI_CEREBRO_MAX_TOKENS: '{"groq": 700, "gemini": 3000}', YUI_REPLY_MAX_TOKENS: '6000' };
    assert.equal(limites.limiteDoProvedor('groq', { env: por }).limite, 700);
    assert.equal(limites.limiteDoProvedor('gemini', { env: por }).limite, 3000);
    assert.equal(limites.limiteDoProvedor('huggingface', { env: por }).limite, 4096, 'sem linha própria: o YUI_REPLY_MAX_TOKENS (cortado pela capacidade 4096)');
    assert.equal(limites.limiteDoProvedor('gemini', { env: { YUI_CEREBRO_MAX_TOKENS: '900' } }).limite, 900, 'um número vale para todos');
    const ruim = limites.ajustesDoCerebro({ YUI_CEREBRO_MAX_TOKENS: '{ruim' });
    assert.match(ruim.erro, /JSON/);
    assert.equal(limites.limiteDoProvedor('gemini', { env: { YUI_CEREBRO_MAX_TOKENS: '{ruim' } }).limite, 2048, 'JSON inválido: os padrões');
    assert.equal(limites.tetoGlobal({ YUI_MAX_TOKENS_TETO: '50' }), 256, 'teto abaixo da faixa é ajustado');
    assert.equal(limites.tetoGlobal({ YUI_MAX_TOKENS_TETO: '99999' }), 8192);
    assert.equal(limites.limiteOpenAiCompativel({ AI_MAX_TOKENS: '1500' }), 1500, 'openai-compatible: o AI_MAX_TOKENS de sempre');
    assert.equal(limites.limiteOpenAiCompativel({ AI_MAX_TOKENS: '1500', YUI_MAX_TOKENS_TETO: '1000' }), 1000, 'abaixo do teto');
  });
  await test('o roteador do Gateway manda a CADA provedor o limite dele (na troca de provedor também); sem pedido, nada muda', async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push({ url, max: body.max_tokens });
      if (url.includes('primeiro')) return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'erro' };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'oi' }, finish_reason: 'stop' }] }) };
    };
    const providers = [
      { id: 'groq', endpoint: 'https://primeiro.test/v1/chat/completions', keys: ['chave-falsa-123'], models: [{ id: 'm1', tier: 'smart' }], headers: {} },
      { id: 'meu-proprio', endpoint: 'https://segundo.test/v1/chat/completions', keys: ['chave-falsa-456'], models: [{ id: 'm2', tier: 'smart' }], headers: {}, maxTokens: 300 },
    ];
    const router = createRouter({ providers, fetchImpl });
    const out = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'oi' }], max_tokens: 4096 }, { maxTokensFor: limites.limitePorProvedor({}) });
    assert.deepEqual(bodies.map((b) => b.max), [1024, 300], 'groq 1024 (padrão) e o provedor próprio 300 (capacidade declarada)');
    assert.equal(out.x_gateway.max_tokens, 300, 'o limite usado vem no x_gateway');
    bodies.length = 0;
    const router2 = createRouter({ providers, fetchImpl });
    const out2 = await router2.chat({ model: 'auto', messages: [{ role: 'user', content: 'oi' }], max_tokens: 1500 });
    assert.deepEqual(bodies.map((b) => b.max), [1500, 1500], 'sem maxTokensFor: o max_tokens do pedido, como sempre');
    assert.equal(out2.x_gateway.max_tokens, undefined);
  });
  await test('AI Manager + Gateway de verdade (fetch falso): com tokensPorProvedor cada provedor recebe o seu; sem ele, o AI_MAX_TOKENS de sempre', async () => {
    const seen = [];
    fetchHook = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ host: new URL(url).hostname, max: body.max_tokens });
      if (url.includes('groq')) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'fora' };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'resposta do gemini' }, finish_reason: 'stop' }] }) };
    };
    const saved = { ...process.env };
    Object.assign(process.env, { GEMINI_API_KEY: 'AIzaChaveFalsaSoParaTeste1234567890', YUI_GATEWAY_DISABLE: 'pollinations', YUI_GATEWAY_IN_CHAIN: 'true' });
    try {
      gatewayIndex.resetGateway();
      manager.initAiManager();
      manager.setActiveBackend('gateway');
      const ctx = { userId: MEMBER, platform: 'discord', memoryScope: 'public' };
      const a = await manager.chat({ prompt: 'oi', system: 'sys', ctx, tokensPorProvedor: true });
      assert.equal(a, 'resposta do gemini');
      assert.deepEqual(seen.map((s) => [s.host.split('.').at(-2), s.max]), [['groq', 1024], ['googleapis', 2048]]);
      seen.length = 0;
      gatewayIndex.resetGateway();
      await manager.chat({ prompt: 'oi', system: 'sys', ctx });
      assert.deepEqual(seen.map((s) => s.max), [1500, 1500], 'o app (sem tokensPorProvedor): o AI_MAX_TOKENS (1500) de sempre');
    } finally {
      fetchHook = null;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      gatewayIndex.resetGateway();
      manager.initAiManager();
    }
  });
  await test('o cérebro pede o limite por provedor em TODA chamada à IA (conversa, síntese da pesquisa, otimizador da busca)', async () => {
    const { chat, research, ai } = brains();
    await chat.turn({ ...facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), step: 1, prompt: 'user: "oi"', options: { main: true } }, META);
    await research.turn({ ...facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do PS5' }), pedido: { question: 'pesquise o preço do PS5', query: 'preço PS5' } }, { ...META, idem: 'k1' });
    assert.ok(ai.calls.length >= 2);
    for (const c of ai.calls) assert.equal(c.tokensPorProvedor, true, `chamada ${c.tipo} sem o limite por provedor`);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. A pesquisa inteira no cérebro');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('research.turn público: busca, escolha das fontes, leitura, síntese e organização no cérebro; o progresso só com a chave do pedido', async () => {
    limparRegistro();
    const events = [];
    const { chat, research, ai } = brains({ emit: (ev, payload) => events.push({ ev, ...payload }) });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do PS5 tok-M1' });
    const out = await research.turn({ ...f, pedido: { question: 'pesquise o preço do PS5 tok-M1', query: 'preço PS5 tok-M1' } }, { ...META, idem: 'research.turn:x:1' });
    assert.equal(out.kind, 'answer', out.text);
    assert.match(out.text, /📎 \*\*Fontes:\*\*/, 'as fontes vêm organizadas pelo código');
    assert.match(out.text, /-# 🔎 Search/, 'o rodapé que mantém a resposta fora do contexto');
    const synth = ai.calls.find((c) => c.tipo === 'sintese');
    assert.ok(synth, 'a síntese rodou no cérebro');
    assert.equal(synth.isolated, true, 'síntese sem histórico e sem memória (chamada isolada)');
    assert.equal(synth.sensitive, false);
    assert.ok(!String(synth.system).includes('--- FERRAMENTAS DISPONÍVEIS ---'), 'síntese sem ferramentas');
    assert.ok(String(synth.prompt).includes('tok-PAGINA'), 'as páginas foram lidas no cérebro');
    assert.deepEqual(registro().filter((r) => r.tipo === 'agente').length, 1, 'uma busca');
    assert.ok(events.length >= 1 && events.every((e) => e.ev === 'research.progress' && e.chave === 'research.turn:x:1'), 'progresso só com a chave do pedido');
    assert.equal(chat.foiPesquisado(f.turn.id), true, 'o turno ficou marcado como pesquisado');
    const c = await chat.commit({ ...f, history: [{ role: 'user', content: 'pesquise' }, { role: 'assistant', content: 'Pesquisei na web e respondi.' }], contextLine: 'texto vindo da web' }, META);
    assert.equal(c.context, false, 'resposta com pesquisa NÃO entra no contexto por horas, mesmo se o bot mandar a linha');
  });
  await test('conversa privada: sem YUI_PRIVATE_SEARCH a pesquisa é recusada SEM chegar ao buscador (o Braga em DM e um membro em DM)', async () => {
    limparRegistro();
    const { research } = brains();
    const o = await research.turn({ ...facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço do PS5' }), pedido: { question: 'pesquise o preço do PS5', query: 'ps5' } }, META);
    const m = await research.turn({ ...facts({ user: MEMBER, channel: '777777777777777778', text: 'pesquise o preço do PS5' }), pedido: { question: 'pesquise o preço do PS5', query: 'ps5' } }, META);
    assert.equal(o.kind, 'refused');
    assert.equal(o.text, SENSITIVE_SEARCH_REFUSAL);
    assert.equal(m.kind, 'refused', 'a DM de qualquer pessoa é privada');
    assert.equal(registro().length, 0, 'nenhuma consulta saiu');
  });
  await test('privada liberada (YUI_PRIVATE_SEARCH=owner): só o Braga; consulta SÓ do texto literal (a do modelo é ignorada); síntese sem provedor anônimo e sem o canal', async () => {
    limparRegistro();
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    try {
      const { research, ai } = brains();
      const pergunta = 'pesquise o preço do PS5 tok-B1 porque estou juntando dinheiro pro aniversário da Fulana';
      const out = await research.turn({ ...facts({ user: OWNER, channel: DMCH, text: pergunta }), pedido: { question: pergunta, query: 'consulta inventada pelo modelo tok-MODELO', intent: 'tok-INTENCAO' } }, META);
      assert.equal(out.kind, 'answer', out.text);
      assert.equal(out.private, true);
      const consultas = registro().filter((r) => r.tipo === 'agente');
      assert.equal(consultas.length, 1);
      assert.ok(!consultas[0].consulta.includes('tok-MODELO') && !/Fulana|aniversário/.test(consultas[0].consulta), 'só o pedido literal, sem a justificativa pessoal nem a consulta do modelo');
      assert.ok(consultas[0].consulta.includes('tok-B1'));
      assert.equal(consultas[0].privado, true);
      const synth = ai.calls.find((c) => c.tipo === 'sintese');
      assert.equal(synth.sensitive, true, 'síntese privada nunca vai a provedor anônimo');
      assert.ok(!String(synth.prompt).includes('tok-INTENCAO'), 'a intenção do modelo não entra na pesquisa privada');
      assert.match(out.historyLine, /conversa privada/);
      limparRegistro();
      const m = await research.turn({ ...facts({ user: MEMBER, channel: '777777777777777778', text: 'pesquise o preço do PS5' }), pedido: { question: 'pesquise o preço do PS5', query: 'ps5' } }, META);
      assert.equal(m.kind, 'refused', 'owner: o membro em DM continua sem pesquisa privada');
      assert.equal(registro().length, 0);
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });
  await test('pesquisa DIRETA no cérebro (YUI_PRIVATE_SEARCH_DIRETA): o research.turn da DM pesquisa sem o "pesquise" só para quem a chave libera; consulta só da fala', async () => {
    limparRegistro();
    process.env.YUI_PRIVATE_SEARCH = 'all';
    const pergunta = 'quanto está o PS5 tok-D1 hoje?';
    try {
      const { research } = brains();
      const turn = (user, channel) => research.turn({ ...facts({ user, channel, text: pergunta }), pedido: { question: pergunta, query: 'consulta inventada pelo modelo tok-MODELO' } }, META);
      process.env.YUI_PRIVATE_SEARCH_DIRETA = 'off';
      const a = await turn(OWNER, DMCH);
      assert.equal(a.kind, 'refused');
      assert.equal(registro().length, 0, 'chave desligada: nada saiu');
      process.env.YUI_PRIVATE_SEARCH_DIRETA = 'owner';
      const b = await turn(OWNER, DMCH);
      assert.equal(b.kind, 'answer', b.text);
      assert.equal(b.private, true);
      const consultas = registro().filter((r) => r.tipo === 'agente');
      assert.equal(consultas.length, 1);
      assert.ok(consultas[0].consulta.includes('tok-D1') && !consultas[0].consulta.includes('tok-MODELO'), 'a consulta é só da fala');
      assert.equal(consultas[0].privado, true);
      limparRegistro();
      const c = await turn(MEMBER, '777777777777777778');
      assert.equal(c.kind, 'refused', 'owner: o membro em DM continua sem a forma direta');
      assert.equal(registro().length, 0);
      process.env.YUI_PRIVATE_SEARCH_DIRETA = 'all';
      const d = await turn(MEMBER, '777777777777777778');
      assert.equal(d.kind, 'answer', d.text);
      assert.equal(d.private, true);
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
      delete process.env.YUI_PRIVATE_SEARCH_DIRETA;
    }
  });
  await test('recusas do cérebro: voz, conversa espontânea e search_web desligada no servidor (nada chega ao buscador)', async () => {
    limparRegistro();
    llm.setServerToolEnabled(GUILD_OFF, 'search_web', false);
    const { research } = brains();
    const voz = await research.turn({ ...facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise x', call: { voice: true, voiceItem: true, voiceInteraction: true } }), pedido: { question: 'pesquise x', query: 'x' } }, META);
    const esp = await research.turn({ ...facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise x', call: { chatter: true } }), pedido: { question: 'pesquise x', query: 'x' } }, META);
    const off = await research.turn({ ...facts({ user: MEMBER, guild: GUILD_OFF, channel: CHAN, text: 'pesquise x' }), pedido: { question: 'pesquise x', query: 'x' } }, META);
    assert.equal(voz.text, VOICE_REFUSAL);
    assert.equal(esp.text, pesquisa.SPONTANEOUS_NO_SEARCH_TEXT);
    assert.equal(off.text, SEARCH_DISABLED_REPLY);
    assert.equal(registro().length, 0);
  });
  await test('isolamento: o Braga em DM (privada liberada) e um membro no servidor AO MESMO TEMPO; cada um só vê a própria evidência e o próprio progresso', async () => {
    limparRegistro();
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    buscaControle({ atrasoMs: 300 });
    try {
      const events = [];
      const { research, ai } = brains({ emit: (ev, payload) => events.push(payload) });
      const a = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço do PS5 tok-DONO' });
      const b = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do Xbox tok-MEMBRO' });
      const [ra, rb] = await Promise.all([
        research.turn({ ...a, pedido: { question: a.ownText, query: 'ps5 tok-DONO' } }, { ...META, idem: `research.turn:${a.turn.id}:1` }),
        research.turn({ ...b, pedido: { question: b.ownText, query: 'xbox tok-MEMBRO' } }, { ...META, idem: `research.turn:${b.turn.id}:1` }),
      ]);
      assert.match(ra.text, /marcas=\[[^\]]*tok-DONO/);
      assert.ok(!ra.text.includes('tok-MEMBRO'), 'vazamento: o dono viu a evidência do membro');
      assert.match(rb.text, /marcas=\[[^\]]*tok-MEMBRO/);
      assert.ok(!rb.text.includes('tok-DONO'), 'vazamento: o membro viu a evidência do dono');
      const sinteses = ai.calls.filter((c) => c.tipo === 'sintese');
      assert.deepEqual(sinteses.map((s) => s.sensitive).sort(), [false, true], 'a do dono é sensível, a do membro não');
      const porChave = new Map();
      for (const e of events) porChave.set(e.chave, [...(porChave.get(e.chave) ?? []), e.linha]);
      assert.equal(porChave.size, 2, 'um fio de progresso por pedido');
      const linhasDono = porChave.get(`research.turn:${a.turn.id}:1`).join(' ');
      assert.ok(!/tok-DONO|PS5/i.test(linhasDono), 'o progresso da pesquisa PRIVADA não mostra a consulta');
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
      buscaControle({});
    }
  });
  await test('ramo antigo (YUI_RESEARCH_ENABLED=false) também no cérebro: busca rápida, leitura e a resposta COM a web cercada, sem ferramentas', async () => {
    limparRegistro();
    const { research, ai } = brains({ env: { ...process.env, YUI_RESEARCH_ENABLED: 'false' } });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise sobre Hytale tok-ANT' });
    const out = await research.turn({ ...f, pedido: { antigo: true, query: 'Hytale tok-ANT', prompt: 'user: "pesquise sobre Hytale tok-ANT"', question: 'pesquise sobre Hytale tok-ANT' } }, META);
    assert.match(out.text, /-# 🔎 Search$/);
    assert.equal(out.usedSearch, true);
    assert.equal(registro().filter((r) => r.tipo === 'rapida').length, 1);
    const call = ai.calls.find((c) => c.tipo === 'conversa');
    assert.ok(/DADOS|não confiáve|NÃO CONFIÁVE/i.test(String(call.prompt)), 'a web vai cercada como dado não confiável');
    assert.ok(!String(call.system).includes('--- FERRAMENTAS DISPONÍVEIS ---'));
  });
  await test('busca automática no passo (allowSearch): roda no cérebro só com a fala do autor; nunca em conversa sensível nem com a pesquisa desligada', async () => {
    limparRegistro();
    const { chat, ai } = brains();
    const pub = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do PS5 tok-AUTO' });
    const r = await chat.turn({ ...pub, step: 1, prompt: '--- CONTEXTO ---\noutra pessoa: tok-TERCEIRO\n--- MENSAGEM ATUAL ---\npesquise o preço do PS5 tok-AUTO', options: { noTools: true, allowSearch: true, searchPrompt: 'pesquise o preço do PS5 tok-AUTO' } }, META);
    assert.equal(r.usedSearch, true);
    const consultas = registro().filter((x) => x.tipo === 'rapida');
    assert.equal(consultas.length, 1);
    assert.ok(consultas[0].consulta.includes('tok-AUTO') && !consultas[0].consulta.includes('tok-TERCEIRO'), 'só a fala do autor vai ao buscador');
    const otim = ai.calls.find((c) => c.tipo === 'otimizador');
    assert.equal(otim.isolated, true, 'otimizador sem histórico nem memória');
    assert.equal(otim.sensitive, true, 'otimizador nunca em provedor anônimo');
    assert.equal(chat.foiPesquisado(pub.turn.id), true);
    limparRegistro();
    const dono = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço do PS5' });
    const r2 = await chat.turn({ ...dono, step: 1, prompt: 'pesquise o preço do PS5', options: { noTools: true, allowSearch: true, searchPrompt: 'pesquise o preço do PS5' } }, META);
    assert.equal(r2.usedSearch, false, 'conversa sensível não pesquisa');
    const off = facts({ user: MEMBER, guild: GUILD_OFF, channel: CHAN, text: 'pesquise o preço do PS5' });
    const r3 = await chat.turn({ ...off, step: 1, prompt: 'pesquise o preço do PS5', options: { noTools: true, allowSearch: true, searchPrompt: 'pesquise o preço do PS5' } }, META);
    assert.equal(r3.usedSearch, false, 'search_web desligada vale para a busca automática');
    assert.equal(registro().length, 0);
  });
  await test('/yui inteiro no cérebro (chat.yui): a resposta com a busca automática, o rodapé 🔎 e o turno fora do contexto', async () => {
    limparRegistro();
    const events = [];
    const { chat, research } = brains({ emit: (ev, p) => events.push(p) });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do PS5 tok-Y1', entry: 'yui' });
    const out = await research.yui({ ...f, pergunta: 'pesquise o preço do PS5 tok-Y1', contexto: '' }, { ...META, idem: `chat.yui:${f.turn.id}` });
    assert.equal(out.usedSearch, true);
    assert.match(out.text, /-# 🔎 Search/);
    assert.equal(chat.foiPesquisado(f.turn.id), true);
    const c = await chat.commit({ ...f, history: [], contextLine: out.text }, META);
    assert.equal(c.context, false, 'o /yui com pesquisa não entra no contexto');
  });
  await test('/yui: promessa vazia do modelo vira pesquisa de verdade (Porta C) no cérebro; a privada do Braga só com pedido explícito', async () => {
    limparRegistro();
    const promete = fakeAi({ reply: () => 'Vou pesquisar isso e já te falo!' });
    const { research } = brains({ ai: promete, env: { ...process.env, YUI_CEREBRO_BUSCA_AUTOMATICA: 'false' } });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'qual o preço do PS5 hoje tok-Y2', entry: 'yui' });
    const out = await research.yui({ ...f, pergunta: 'qual o preço do PS5 hoje tok-Y2' }, META);
    assert.equal(out.researched, true, out.text);
    assert.match(out.text, /📎 \*\*Fontes:\*\*/);
    assert.equal(registro().filter((r) => r.tipo === 'agente').length, 1);
    limparRegistro();
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    try {
      const resp = fakeAi({ reply: () => 'Acho que custa uns R$ 3.800, mas não tenho certeza.' });
      const { research: r2 } = brains({ ai: resp });
      const d = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço do PS5 tok-Y3', entry: 'yui' });
      const o2 = await r2.yui({ ...d, pergunta: 'pesquise o preço do PS5 tok-Y3' }, META);
      assert.equal(o2.researched, true, 'privada: pedido explícito sem promessa também é pesquisado (searchIfExplicit)');
      assert.ok(registro().every((r) => r.privado === true));
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. Falhas e reconexões com o canal de verdade (A5: o prazo nunca gera uma segunda resposta)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  /** Um "cabo" TCP entre o bot e o cérebro, que o teste pode cortar (o cérebro continua de pé: a conexão cai e volta). */
  async function cabo(targetPort) {
    const sockets = new Set();
    const server = net.createServer((client) => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      sockets.add(client); sockets.add(upstream);
      let first = true;
      client.on('data', (buf) => {
        let b = buf;
        if (first) { first = false; b = Buffer.from(buf.toString('latin1').replace(/Host: 127\.0\.0\.1:\d+/i, `Host: 127.0.0.1:${targetPort}`), 'latin1'); }
        upstream.write(b);
      });
      upstream.on('data', (b) => client.write(b));
      const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
      for (const s of [client, upstream]) { s.on('close', end); s.on('error', end); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
      port: server.address().port,
      cortar() { for (const s of [...sockets]) s.destroy(); },
      fechar: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    };
  }
  async function canalDeVerdade({ ai, env = process.env } = {}) {
    const secretFile = path.join(tmp, 'secrets', `canal-${nextId()}.json`);
    const server = await startChannelServer({ env, port: 0, secretFile, logger: quiet, restrictFile: () => {} });
    const chat = conversa.createChatBrain({ ai, logger: quiet, busca, env, memoryBlock: () => '', persona: () => '' });
    conversa.registerChatMethods(server, { brain: chat, env });
    const reg = pesquisa.registerResearchMethods(server, { chat, ai, busca, env, logger: quiet });
    const fio = await cabo(server.port);
    const client = connectChannel({ role: 'bot', url: `ws://127.0.0.1:${fio.port}`, secretFile, logger: quiet, minBackoffMs: 50, maxBackoffMs: 200 });
    await client.ready(5000);
    turno.setChatRemote(client, { logger: quiet });
    return {
      server, client, fio, chat, research: reg.brain,
      async fechar() { turno.setChatRemote(null); await client.close(); await fio.fechar(); await server.close(); },
    };
  }

  await test('a conexão cai NO MEIO da pesquisa: o bot reconecta e repete com a MESMA chave; a busca roda UMA vez e a resposta sai uma vez', async () => {
    limparRegistro();
    buscaControle({ atrasoMs: 1200 });
    const ai = fakeAi();
    const k = await canalDeVerdade({ ai });
    try {
      const lines = [];
      const t = turno.createRemoteTurn(facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do PS5 tok-R1' }));
      const pending = t.research({ question: 'pesquise o preço do PS5 tok-R1', query: 'ps5 tok-R1' }, { progress: (l) => lines.push(l) });
      await sleep(400);
      k.fio.cortar(); // a conexão cai com a busca rodando no cérebro
      const out = await pending;
      assert.equal(out.kind, 'answer', out.text);
      assert.equal(registro().filter((r) => r.tipo === 'agente').length, 1, 'a repetição com a mesma chave NÃO buscou de novo');
      assert.equal(k.research.stats().pesquisas, 1, 'o cérebro rodou a pesquisa uma vez (o cache do canal devolveu a mesma)');
      assert.ok(k.server.stats().idemReplays >= 1, 'a repetição foi atendida pelo cache de idempotência');
      assert.ok(turno.chatRemoteStats().retries >= 1, 'o bot repetiu depois da queda');
      assert.ok(lines.length >= 1 && lines.every((l) => l.startsWith('-# ')), 'o progresso chegou (antes ou depois da queda) só a este turno');
    } finally {
      buscaControle({});
      await k.fechar();
    }
  });

  await test('o prazo do passo estoura com a IA lenta: um aviso só, nenhuma chamada paralela, nenhuma segunda resposta; a repetição com a mesma chave usa o guardado', async () => {
    process.env.YUI_CHAT_TURN_TIMEOUT_MS = '1000'; // o handler do cérebro corta em 3 s; a IA demora 4,5 s
    const ai = fakeAi({ delayMs: 4500 });
    const k = await canalDeVerdade({ ai, env: { ...process.env } });
    try {
      const chan = '555555555555555901';
      const m = fakeMention({ userId: OTHER, channelId: chan, guildId: GUILD, text: 'tok-PZ1 oi' });
      await ask(m, 'tok-PZ1 oi');
      assert.equal(await waitFinal(m, 20_000), turno.CEREBRO_UNAVAILABLE_TEXT, 'o aviso de indisponível');
      await sleep(3500); // a IA termina no cérebro; nada mais pode sair para esta mensagem
      assert.equal(finals(m).length, 1, 'nenhuma segunda resposta para a mesma mensagem');
      assert.equal(ai.calls.filter((c) => c.tipo === 'conversa').length, 1, 'nenhuma chamada paralela à IA');
      const again = await k.client.request('chat.turn', { ...facts({ id: m.id, user: OTHER, guild: GUILD, channel: chan, text: 'tok-PZ1 oi' }), step: 1, prompt: 'user: "tok-PZ1 oi"', options: { main: true } }, { idem: `chat.turn:${m.id}:1`, timeoutMs: 10_000 });
      assert.match(again.text, /resposta da conversa/, 'a repetição com a MESMA chave devolve o resultado guardado');
      assert.equal(ai.calls.filter((c) => c.tipo === 'conversa').length, 1, 'sem chamar a IA de novo');
      await sleep(1300);
    } finally {
      delete process.env.YUI_CHAT_TURN_TIMEOUT_MS;
      await k.fechar();
    }
  });

  await test('o fim de um turno com pesquisa fica pendente com a conexão caída e é reconciliado depois: entra UMA vez, e sem a linha do contexto', async () => {
    const ai = fakeAi();
    const k = await canalDeVerdade({ ai });
    try {
      const f = facts({ user: MEMBER, guild: GUILD, channel: '555555555555555902', text: 'pesquise o preço do PS5 tok-CM1' });
      const t = turno.createRemoteTurn(f);
      await t.research({ question: f.ownText, query: 'ps5 tok-CM1' });
      t.noteHistory('user', f.ownText);
      t.noteHistory('assistant', 'Pesquisei na web e respondi.');
      t.noteContext('texto da web que não pode entrar');
      k.fio.cortar();
      await sleep(30);
      await t.finish();
      assert.equal(turno.chatRemoteStats().pendingCommits, 1, 'guardado no bot');
      await k.client.ready(5000);
      await turno.flushPendingCommits();
      assert.equal(turno.chatRemoteStats().pendingCommits, 0, 'saiu na reconexão');
      const st = k.chat.stats();
      assert.equal(st.commits, 1, 'uma vez');
      assert.equal(st.researchedContextBlocked, 1, 'a linha do contexto foi recusada pelo cérebro (turno com pesquisa)');
    } finally {
      await k.fechar();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O JSON de ferramenta do cérebro é um PEDIDO, não uma autorização (A4)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  await test('enforce com a regra negando: a ferramenta pedida pelo cérebro passa pelo guardToolCall e é NEGADA (nada executa; fica na auditoria)', async () => {
    // A regra que nega: o dono apertou a categoria CHAT (POLICY_CHAT_AUTONOMY=DENY), então chat.generate_image vira DENY em enforce.
    // (generate_image não abre processo nenhum: mesmo se passasse, a rede do teste está bloqueada)
    process.env.YUI_POLICY_MODE = 'enforce';
    process.env.POLICY_CHAT_AUTONOMY = 'DENY';
    policy.resetPolicyEngineForTests();
    try {
      await comCerebro(() => toolJson('generate_image', { prompt: 'a cat', negative_prompt: 'nsfw' }), async () => {
        const m = fakeMention({ userId: MEMBER, channelId: '555555555555555801', guildId: GUILD, text: 'tok-T1 faz aquilo que eu pedi' });
        await ask(m, 'tok-T1 faz aquilo que eu pedi');
        const r = await waitFinal(m);
        assert.match(r, /não é permitido pela política de segurança/, r);
        assert.ok(!m.outputs.some((p) => /Executando Ação|Gerando|imagem/i.test(JSON.stringify(p))), 'a ferramenta não começou');
        const blocked = auditLines().filter((l) => l.event === 'policy.interaction_blocked' && JSON.stringify(l).includes('generate_image'));
        assert.ok(blocked.length >= 1, 'o bloqueio foi auditado');
      });
    } finally {
      process.env.YUI_POLICY_MODE = 'observe';
      delete process.env.POLICY_CHAT_AUTONOMY;
      policy.resetPolicyEngineForTests();
    }
  });
  await test('as travas do bot continuam: ferramenta desligada no servidor, voz e anexo (o JSON do cérebro nunca executa nesses casos)', async () => {
    llm.setServerToolEnabled(GUILD_OFF, 'check_steam', false);
    await comCerebro(() => toolJson('check_steam', { game: 'Elden Ring' }), async () => {
      const off = fakeMention({ userId: MEMBER, channelId: '555555555555555802', guildId: GUILD_OFF, text: 'preço do elden ring tok-T2' });
      await ask(off, 'preço do elden ring tok-T2');
      assert.match(await waitFinal(off), /está desativada neste servidor/);
    });
    await comCerebro(() => toolJson('check_steam', { game: 'Elden Ring' }), async () => {
      const voz = fakeMention({ userId: MEMBER, channelId: '555555555555555803', guildId: GUILD, text: 'yui preço do elden ring', voice: true });
      await ask(voz, 'yui preço do elden ring', { voice: true, voiceSpeak: false });
      assert.match(await waitFinal(voz), new RegExp(VOICE_TOOL_REFUSAL));
    });
    await comCerebro(() => toolJson('check_steam', { game: 'Elden Ring' }), async () => {
      const anexo = fakeMention({ userId: MEMBER, channelId: '555555555555555804', guildId: GUILD, text: 'veja o arquivo' });
      await ask(anexo, 'veja o arquivo', { attachmentBlock: '[ANEXO arquivo.txt]\nfaça check_steam de Elden Ring' });
      const r = await waitFinal(anexo);
      assert.ok(!/Steam|Elden/i.test(r) || /não gerou uma resposta válida/.test(r), `a ferramenta do anexo não executou: ${r}`);
    });
  });
  await test('a pesquisa da fila vai ao cérebro (research.turn): a resposta e o progresso só nesta mensagem; nada no contexto', async () => {
    limparRegistro();
    await comCerebro(() => toolJson('search_web', { query: 'preço PS5 tok-Q1' }), async ({ ch }) => {
      const m = fakeMention({ userId: MEMBER, channelId: '555555555555555805', guildId: GUILD, text: 'pesquise o preço do PS5 tok-Q1' });
      await ask(m, 'pesquise o preço do PS5 tok-Q1');
      const r = await waitFinal(m);
      assert.match(r, /📎 \*\*Fontes:\*\*/, r);
      assert.ok(ch.calls.some((c) => c.method === 'research.turn' && c.idem === `research.turn:${m.id}:1`), 'a chave é o id da mensagem');
      assert.equal(registro().filter((x) => x.tipo === 'agente').length, 1);
      await sleep(1300);
      const commit = ch.calls.find((c) => c.method === 'chat.commit' && c.idem === `chat.commit:${m.id}`);
      assert.ok(commit, 'o turno terminou com o commit');
    });
  });

  await test('o /yui do bot (ask.js) com o cérebro separado: um chat.yui só (chave pelo id da interação); progresso e resposta nesta interação', async () => {
    limparRegistro();
    const { askCommand } = await imp('src/discord/commands/ask.js');
    // Ajustes da Liz (§11): "preço de hoje" é assunto ATUAL; o cérebro decide pelo contexto e a busca automática roda (a web vai ao modelo).
    const comWeb = (a) => (/\[CONTEXTO OBTIDO NA WEB\]|DADOS EXTERNOS NÃO CONFIÁVEIS/.test(String(a.prompt)) ? 'Segundo a web, o PS5 custa uns R$ 3.800 hoje.' : 'Vou pesquisar isso e já te falo!');
    await comCerebro(comWeb, async ({ ch }) => {
      const edits = [];
      const interaction = {
        id: nextId(), createdTimestamp: Date.now(), user: { id: OTHER }, guildId: GUILD, channelId: '555555555555555808',
        options: { getString: (n) => (n === 'mensagem' ? 'qual o preço do PS5 hoje tok-YB1' : null) },
        isChatInputCommand: () => true, deferred: false, replied: false,
        async deferReply() { this.deferred = true; },
        async editReply(p) { edits.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: '1' }; },
        async followUp(p) { edits.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: '2' }; },
        async reply(p) { edits.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: '3' }; },
        channel: { id: '555555555555555808', send: async (p) => { edits.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: '4' }; } },
      };
      await askCommand.execute(interaction);
      const final = edits.filter((e) => e && !/Processando|^-# /.test(e)).at(-1) ?? '';
      assert.match(final, /Segundo a web/, `a resposta veio com a web achada no cérebro: ${final}`);
      assert.match(final, /-# 🔎 Search/);
      const yuiCalls = ch.calls.filter((c) => c.method === 'chat.yui');
      assert.equal(yuiCalls.length, 1);
      assert.equal(yuiCalls[0].idem, `chat.yui:${interaction.id}`);
      assert.ok(!ch.calls.some((c) => c.method === 'chat.turn' || c.method === 'research.turn'), 'nada de passo nem pesquisa avulsos: o /yui inteiro foi no chat.yui');
      assert.equal(registro().filter((r) => r.tipo === 'rapida' || r.tipo === 'agente').length, 1, 'a busca rodou no cérebro (busca falsa), uma vez');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('E. O "Processando..." guardado (A3)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const PFILE = path.join(tmp, 'db', 'processando-bot.json');
  await test('gravação atômica, estados e prazo; arquivo ilegível vai para o lado', () => {
    const s = processando.createProcessandoStore({ file: PFILE, logger: quiet });
    assert.equal(s.guardar({ mensagemOriginal: '123456789012345678', mensagemProcessando: '223456789012345678', canal: CHAN, conversa: `ch:${CHAN}:u:${MEMBER}`, turno: 't1' }), true);
    assert.equal(s.guardar({ mensagemProcessando: 'abc', canal: CHAN }), false, 'id que não é do Discord não é guardado');
    assert.equal(s.atualizar('223456789012345678', 'pesquisando'), true);
    const disk = JSON.parse(fs.readFileSync(PFILE, 'utf8'));
    assert.equal(disk.registros['223456789012345678'].estado, 'pesquisando');
    assert.equal(disk.registros['223456789012345678'].conversa, `ch:${CHAN}:u:${MEMBER}`);
    assert.ok(Number.isFinite(disk.registros['223456789012345678'].atualizadoEm));
    assert.ok(!fs.readdirSync(path.dirname(PFILE)).some((f) => f.endsWith('.tmp')), 'nada de temporário sobrando');
    assert.ok(!JSON.stringify(disk).includes('tok-'), 'nenhum texto da conversa no arquivo');
    s.remover('223456789012345678');
    assert.equal(processando.createProcessandoStore({ file: PFILE }).size, 0);
    realWrite(PFILE, '{quebrado');
    const s2 = processando.createProcessandoStore({ file: PFILE, logger: quiet });
    assert.equal(s2.size, 0);
    assert.ok(fs.readdirSync(path.dirname(PFILE)).some((f) => f.startsWith('processando-bot.json.corrompido-')), 'o ilegível foi guardado ao lado');
  });
  await test('depois do reinício: edita SÓ o que confere (do bot, no canal, resposta à mensagem original, ainda "Processando..."); vencido não é editado', async () => {
    let now = Date.now();
    const s = processando.createProcessandoStore({ file: path.join(tmp, 'db', 'p2.json'), ttlMs: 60_000, now: () => now });
    const BOT = '900000000000000001';
    const msgs = new Map();
    const mk = (id, { canal = CHAN, author = BOT, ref = '100000000000000001', content = '🧠 **Processando...**\n-# 🔎 Pesquisando…' } = {}) => {
      const m = { id, channelId: canal, author: { id: author }, reference: { messageId: ref }, content, edited: null, async edit(p) { m.edited = p.content; } };
      msgs.set(id, m);
      return m;
    };
    const valida = mk('300000000000000001');
    const respondida = mk('300000000000000002', { content: 'a resposta de verdade já foi entregue' });
    const outra = mk('300000000000000003', { ref: '199999999999999999' });
    const deOutro = mk('300000000000000004', { author: '123123123123123123' });
    const outroCanal = mk('300000000000000005', { canal: '555555555555555000' });
    const vencida = mk('300000000000000006');
    for (const m of [valida, respondida, outra, deOutro, outroCanal]) s.guardar({ mensagemOriginal: '100000000000000001', mensagemProcessando: m.id, canal: CHAN, conversa: `ch:${CHAN}:u:${MEMBER}` });
    s.guardar({ mensagemOriginal: '100000000000000001', mensagemProcessando: '300000000000000007', canal: CHAN }); // mensagem apagada
    s.guardar({ mensagemOriginal: '100000000000000001', mensagemProcessando: '300000000000000008', canal: CHAN }); // Discord fora agora (500)
    now -= 120_000;
    s.guardar({ mensagemOriginal: '100000000000000001', mensagemProcessando: vencida.id, canal: CHAN });
    now += 120_000;
    const client = {
      user: { id: BOT },
      channels: {
        async fetch(id) {
          return {
            id,
            messages: {
              async fetch(mid) {
                if (mid === '300000000000000008') throw Object.assign(new Error('Internal'), { status: 500 });
                const m = msgs.get(mid);
                if (!m) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
                return m;
              },
            },
          };
        },
      },
    };
    const out = await processando.recuperarProcessando({ store: s, client, logger: quiet });
    assert.equal(valida.edited, processando.AVISO_REINICIO, 'a mensagem parada recebeu o aviso');
    for (const m of [respondida, outra, deOutro, outroCanal, vencida]) assert.equal(m.edited, null, `não editou ${m.id}`);
    assert.deepEqual(out, { editadas: 1, vencidas: 1, recusadas: 4, falhas: 1, mantidas: 1 });
    assert.deepEqual(s.listar().map((r) => r.mensagemProcessando), ['300000000000000008'], 'só o do erro passageiro fica para a próxima');
  });
  await test('a fila guarda o "Processando..." durante o turno (com o estado) e apaga no fim; no processo único nada é guardado', async () => {
    const store = processando.ligarProcessando({ file: path.join(tmp, 'db', 'p3.json'), logger: quiet });
    try {
      const estados = [];
      await comCerebro(async () => { estados.push(store.listar().map((r) => r.estado)); return 'oi de volta tok-S1'; }, async () => {
        const m = fakeMention({ userId: MEMBER, channelId: '555555555555555806', guildId: GUILD, text: 'tok-S1 oi' });
        await ask(m, 'tok-S1 oi');
        await waitFinal(m);
        assert.deepEqual(estados, [['processando']], 'durante o turno o registro existia');
        assert.equal(store.listar()[0]?.mensagemProcessando ?? null, null, 'no fim o registro saiu');
        await sleep(200);
        assert.equal(store.size, 0);
      });
      // processo único: sem o turno do cérebro, mesmo com o store ligado, nada é guardado
      const m2 = fakeMention({ userId: MEMBER, channelId: '555555555555555807', guildId: GUILD, text: 'oi processo único' });
      let during = null;
      const realPost = axios.post;
      axios.post = async (url, body) => { if (String(url) === config.groqApiUrl) { during = store.size; return { data: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } }; } throw new Error('offline'); };
      try { await ask(m2, 'oi processo único'); await waitFinal(m2); } finally { axios.post = realPost; }
      assert.equal(during, 0, 'sem a chave nada é guardado');
      await sleep(1300);
    } finally {
      processando.desligarProcessando();
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
