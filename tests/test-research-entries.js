// Testes das ENTRADAS FORA DA FILA do AGENTE DE PESQUISA (Pacote 6): o /yui e o "+yui perguntar" (ask.js + messageAdapter.js) e o APP/API
// (core/ai/manager.js + core/api/server.js). Respondem ao relato "pedi uma pesquisa e a Yui respondeu só que ia pesquisar, e parou por aí":
// o /yui, o +yui e o app usam o MESMO agente da fila (Porta A pré-rota; Portas C e D promessa vazia e guarda final), com a pesquisa em conversa
// PRIVADA (o app é sempre privado; o /yui do dono em DM ou em canal privado) regida pelo YUI_PRIVATE_SEARCH e pelas proteções do modo privado.
// Rodam SEM rede, SEM Discord real e SEM os bancos reais: o diretório de trabalho e os bancos ficam numa pasta temporária; axios, fetch, DNS e
// sockets viram dublês (só o loopback 127.0.0.1 fica aberto, para o servidor HTTP do app, em porta 0); os modelos são dublês de axios; o buscador
// é um SearXNG falso. NUNCA dependem do .env (todas as YUI_RESEARCH_* e a YUI_PRIVATE_SEARCH são definidas aqui).
// Execução: npm run test:researchentries   (node tests/test-research-entries.js)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── Ambiente isolado (tudo explícito: o teste nunca depende do .env do dono) ──────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-researchentries-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  YUI_OWNER_ID: '111',
  YUI_PRIVATE_CHANNEL_IDS: 'priv1',
  YUI_MEMORY_ENABLED: 'true',
  YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  YUI_SEARCH_PROVIDERS: 'searxng',
  SEARXNG_URL: 'http://searx.invalid/',
  LOG_LEVEL: 'error',
  // Pesquisa: o padrão do CÓDIGO (chave mestra ligada, guarda ligada, pré-rota desligada, privado desligado), escrito de propósito.
  YUI_RESEARCH_ENABLED: 'true',
  YUI_RESEARCH_GUARD: 'on',
  YUI_RESEARCH_PRE_ROUTE: 'false',
  YUI_PRIVATE_SEARCH: 'off',
  YUI_SEARCH_GLOBAL_PER_HOUR: '0', // o teto global tem teste próprio (test-research-queue); sem ele as dezenas de buscas daqui estourariam os 20 por hora
  YUI_SEARCH_USER_PER_HOUR: '5',
  YUI_CONTEXT_ENABLED: 'false',
  YUI_CONTEXT_SCOPE: 'all',
  AI_PRIVATE_LOCAL_ONLY: 'false',
});
for (const k of ['YUI_RESEARCH_MAX_STEPS', 'YUI_RESEARCH_PAGES', 'YUI_RESEARCH_DEADLINE_MS', 'YUI_RESEARCH_CHARGE_ALL', 'YUI_RESEARCH_SOURCES', 'YUI_AI_DEADLINE_SECONDS',
  'YUI_VOICE_TOOLS', 'YUI_QUEUE_MAX', 'YUI_QUEUE_MAX_PER_USER', 'YUI_REPLY_MAX_TOKENS', 'YUI_REPLY_MAX_PARTS', 'YUI_UPLOAD_LIMIT_MB', 'YUI_ASK_MAX_CHARS',
  'AI_BACKEND', 'GEMINI_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'BRAVE_API_KEY', 'TAVILY_API_KEY', 'YUI_API_TOKENS']) delete process.env[k];
process.env.GROQ_API_KEY = 'gsk_chave_falsa_so_para_o_teste_1234567890';
process.env.GEMINI_API_KEY = 'AIzaChaveFalsaSoParaOTeste1234567890';
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) {
  try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ }
}
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

// Nada sai da máquina: axios, fetch, DNS e sockets viram dublês (o loopback fica aberto para o servidor do app).
const { default: axios } = await import('axios');
const calls = []; // chamadas ao axios.post: { url, body, config }
let postHook = null; // (url, body, config) => resposta falsa de axios, ou undefined para falhar como o resto
axios.post = async (url, body, cfg) => {
  calls.push({ url: String(url), body, config: cfg });
  const fake = postHook ? await postHook(String(url), body, cfg) : undefined;
  if (fake !== undefined) return fake;
  throw new Error('offline (teste)');
};
axios.get = async () => { throw new Error('offline (teste)'); };
const fetchLog = []; // URLs pedidas ao buscador falso
let searchMode = 'hit'; // hit | empty | down | rate
let searchHook = null; // (url) => resposta falsa de fetch (substitui o modo)
const jsonResp = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(obj) });
const searxResults = (q) => ([
  { title: `Tudo sobre ${q}`, url: 'https://exemplo.test/artigo/principal', content: `Reportagem completa com os detalhes mais recentes sobre ${q}, incluindo números e datas.` },
  { title: `${q}: perguntas e respostas`, url: 'https://outro.example/guia/perguntas', content: `Guia com as perguntas frequentes sobre ${q} e dicas práticas para quem quer saber mais.` },
]);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('http://searx.invalid/search')) throw new Error(`fetch bloqueado no teste: ${u.slice(0, 50)}`);
  fetchLog.push(u);
  if (searchHook) return searchHook(u, init);
  const q = new URL(u).searchParams.get('q') ?? '';
  if (searchMode === 'down') throw new Error('buscador fora do ar (teste)');
  if (searchMode === 'empty') return jsonResp({ results: [] });
  if (searchMode === 'rate') return jsonResp({ error: 'too many requests' }, 429);
  return jsonResp({ results: searxResults(q) });
};
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const o = args[0];
  const host = o && typeof o === 'object' ? (o.host ?? 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(String(host))) throw new Error('rede bloqueada no teste');
  return realConnect.apply(this, args);
};
dns.promises.lookup = async () => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; throw e; };
const realLookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  // o loopback passa (o servidor do app escuta em 127.0.0.1); qualquer outro nome não resolve
  if (net.isIP(String(host)) || /^localhost$/i.test(String(host))) return realLookup(host, opts, cb);
  const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e);
};

// Escritas em arquivos REAIS do projeto são desviadas (server_tools, bans, cotação, historico.txt...).
const realWriteFileSync = fs.writeFileSync;
const realAppendFile = fs.appendFile;
fs.writeFileSync = function guardedWrite(file, ...rest) {
  if (/[\\/]data[\\/](server_tools|bans|currency_cache|channel_settings|server_prompts|server_settings)\.json$/.test(String(file))) return undefined;
  return realWriteFileSync.call(this, file, ...rest);
};
fs.appendFile = function guardedAppend(file, data, cb) {
  if (String(file).endsWith(path.join('data', 'historico.txt'))) { if (typeof cb === 'function') cb(null); return undefined; }
  return realAppendFile.call(this, file, data, cb);
};

// ── Mini-runner ─────────────────────────────────────────────────────────────────────────────────
const say = (s) => process.stdout.write(`${s}\n`);
let passed = 0;
const failures = [];
const only = process.env.YUI_TEST_ONLY ? new RegExp(process.env.YUI_TEST_ONLY) : null;
const test = async (name, fn) => {
  if (only && !only.test(name)) return;
  try {
    await fn();
    passed++;
    say(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 7).join('\n        ')}`);
  }
};
const section = (title) => say(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readSrc = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
/** Roda `fn` com variáveis de ambiente trocadas (valor null apaga) e as restaura no fim, mesmo se falhar. */
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── Módulos sob teste ───────────────────────────────────────────────────────────────────────────
const { default: config } = await import('../src/config/index.js');
config.saveHistory = false; // NUNCA escrever no historico.txt real
const { logger } = await import('../src/utils/logger.js');
const { askCommand } = await import('../src/discord/commands/ask.js');
const { createMessageAdapter } = await import('../src/discord/messageAdapter.js');
const { handlePrefixCommand } = await import('../src/discord/prefixRouter.js');
const manager = await import('../src/core/ai/manager.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { initMemory } = await import('../src/core/index.js');
const { resetCooldowns } = await import('../src/search/providers.js');
const { getDefaultBudget } = await import('../src/search/budget.js');
const { readContextTurns, resolveContextTarget } = await import('../src/core/context/contextStore.js');
const intent = await import('../src/handlers/searchIntent.js');
const llmNames = await import('../src/handlers/llmHandler.js');
await initMemory();
// O /yui monta o contexto do GTA com os repositórios do jogo (como no bootstrap): bancos VAZIOS, só na pasta temporária.
const { initDatabase } = await import('../src/database/db.js');
const { GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA } = await import('../src/database/schemas.js');
await initDatabase('gta-diario', GTA_DAILY_SCHEMA);
await initDatabase('gta-semanal', GTA_WEEKLY_SCHEMA);
console.log = console.warn = console.error = () => {}; // o llmHandler é falante; o resultado sai por say()

// Registro do logger (o winston grava em arquivo; aqui só se observa o que foi dito).
const logLines = [];
for (const level of ['info', 'warn', 'error']) logger[level] = (...args) => { logLines.push(`${level}: ${args.map(String).join(' ')}`); };
const logged = (re) => logLines.some((l) => re.test(l));

// ── Dublês de IA ────────────────────────────────────────────────────────────────────────────────
const okReply = (c) => ({ data: { choices: [{ message: { content: c }, finish_reason: 'stop' }] } });
const URL_GROQ = config.groqApiUrl;
const isPollinations = (c) => /pollinations/i.test(c.url);
const isHorde = (c) => c.url === config.hordeUrl;
const lastUserOf = (body) => String(body?.messages?.at(-1)?.content ?? '');
/** A chamada é a SÍNTESE da pesquisa (o prompt do agente) e não a pergunta principal? */
const isSynthBody = (body) => lastUserOf(body).includes('[RESULTADOS DA PESQUISA NA WEB');
const SYNTH_ANSWER = 'O custo fica perto de R$ 900 por mês em planos de 48 parcelas [1]. A manutenção costuma pesar mais em modelos antigos [2].';
const NEUTRAL_LINE = 'Pesquisei na web a pedido do usuário (conversa privada) e respondi.';
const OWNER = '111'; // o dono (YUI_OWNER_ID): na DM dele a conversa é privada (memoryScope "personal")
const SEARCH_ASK = 'pesquise sobre o lançamento do Hytale';
const PS5_ASK = 'pesquise o preço do ps5 hoje';
const isProgressText = (c) => /^🧠 \*\*Processando/.test(c);
const isResearchAnswer = (t) => t.includes('Fontes:') && t.includes('🔎 Search');
const isSummary = (t) => /resumo automático \(sem IA\)/.test(t);
/** Sem a promessa parada: nenhuma das frases típicas aparece como resposta. */
const noPromise = (t) => !/\b(vou (?:pesquisar|buscar|procurar|dar uma olhada)|um segundo|já te respondo|já volto|pesquisando\.\.\.)\b/i.test(t);
const searches = () => fetchLog.length;
const queryOf = (i = 0) => { try { return new URL(fetchLog[i]).searchParams.get('q'); } catch { return null; } };

/** Modelo scriptado (Groq): script(n, body) devolve o texto da resposta, ou undefined para falhar como o resto. */
function installModel(script) {
  let n = 0;
  postHook = async (url, body) => {
    if (url !== URL_GROQ) return undefined;
    const out = script ? await script(++n, body) : undefined;
    return typeof out === 'string' ? okReply(out) : undefined;
  };
}
function resetRun(search = 'hit') {
  calls.length = 0; fetchLog.length = 0; logLines.length = 0; searchMode = search; searchHook = null;
}

// ── Interações falsas do Discord ────────────────────────────────────────────────────────────────
let seq = 0;
const discordError = (status, code) => Object.assign(new Error(`Discord ${status}/${code ?? ''}`), { status, code });
/** /yui (comando de barra). editReply e followUp acumulam em `edits`; `outputs` é tudo que a pessoa veria, em ordem. */
function fakeSlash({ userId, channelId, guildId = 'g1', pergunta, visibilidade = null, failFollowUp = false, failEdit = false } = {}) {
  const it = {
    user: { id: userId, tag: `u${userId}#0001` }, channelId, guildId, guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    deferred: false, replied: false, ephemeral: false, createdTimestamp: Date.now(),
    edits: [], replies: [], sends: [],
    isChatInputCommand: () => true,
    options: { getString: (n) => (n === 'mensagem' ? pergunta : visibilidade) },
    async deferReply(o) { this.deferred = true; this.ephemeral = Boolean(o?.ephemeral); },
    async editReply(p) { if (failEdit) throw discordError(403, 50013); this.edits.push(p); return { id: 'e1', channel: this.channel }; },
    async reply(p) { this.replied = true; this.replies.push(p); return { id: 'r1' }; },
    async followUp(p) { if (failFollowUp) throw discordError(403, 50013); this.edits.push(p); return { id: 'f1', channel: this.channel }; },
    get outputs() { return [...this.replies, ...this.edits, ...this.sends]; },
  };
  it.channel = { id: channelId, name: 'geral', async send(p) { if (failFollowUp) throw discordError(403, 50013); it.sends.push(p); return { id: 'sent' }; } };
  return it;
}
const contentsOf = (it) => it.outputs.map((p) => (typeof p?.content === 'string' ? p.content : '')).filter(Boolean);
/** O texto FINAL entregue (último conteúdo que não é progresso). */
const finalText = (it) => [...contentsOf(it)].reverse().find((c) => !isProgressText(c)) ?? '';
const progressEdits = (it) => contentsOf(it).filter((c) => isProgressText(c) && /-# (?:🔎|📖|✍️)/u.test(c));

/** Roda o /yui (askCommand.execute) com o modelo scriptado. Devolve a interação e as chamadas ao modelo. */
async function yui({ text, userId, channelId, guildId = 'g1', visibility = null, script, search = 'hit', slashOpts = {} } = {}) {
  resetRun(search);
  seq++;
  installModel(script);
  const uid = userId ?? `y${seq}`;
  const chan = channelId ?? `chan-y${seq}`;
  const it = fakeSlash({ userId: uid, channelId: chan, guildId, pergunta: text, visibilidade: visibility, ...slashOpts });
  const ret = await askCommand.execute(it);
  await sleep(80);
  if (process.env.YUI_TEST_DEBUG) say(`      [debug] ${logLines.filter((l) => /^error|^warn/.test(l)).join('\n      [debug] ')}`);
  return { it, ret, modelCalls: calls.filter((c) => c.url === URL_GROQ) };
}
/** "+yui perguntar ..." pelo roteador do prefixo (adaptador de mensagem de verdade). */
function fakePrefixMessage(content, { authorId, channelId = 'chan-prefix', guildId = null } = {}) {
  const m = {
    content, author: { id: authorId, username: 'bob', bot: false }, guild: guildId ? { id: guildId } : null, member: null, channelId, guildId,
    mentions: { channels: { first: () => null } },
    sent: [], edits: [], replies: [],
    channel: { id: channelId, send: async (p) => { m.sent.push(p); return { id: `w${seq++}`, edit: async (e) => { m.edits.push(e); return { id: 'w1' }; }, channel: m.channel }; } },
    reply: async (p) => { m.replies.push(p); return { id: `r${seq++}` }; },
    get outputs() { return [...m.sent, ...m.edits, ...m.replies]; },
  };
  return m;
}
async function prefixYui({ text, authorId, channelId, guildId = null, script, search = 'hit' } = {}) {
  resetRun(search);
  seq++;
  installModel(script);
  const m = fakePrefixMessage(`+yui perguntar ${text}`, { authorId: authorId ?? `p${seq}`, channelId: channelId ?? `chan-p${seq}`, guildId });
  await handlePrefixCommand(m);
  await sleep(80);
  return { m, modelCalls: calls.filter((c) => c.url === URL_GROQ), final: [...contentsOf({ outputs: m.outputs })].reverse().find((c) => !isProgressText(c) && !/^⏳ Processando/.test(c)) ?? '' };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('A. messageAdapter: quem pediu e onde, como numa interaction');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('o adaptador expõe user, authorId, guild, guildId, channelId e channel (servidor e DM)', () => {
  const channel = { id: 'c1', name: 'geral', send: async () => ({}) };
  const a = createMessageAdapter({ author: { id: '42', username: 'ana' }, guild: { id: 'G1' }, channelId: 'c1', channel });
  assert.deepEqual([a.user.id, a.authorId, a.guild.id, a.guildId, a.channelId], ['42', '42', 'G1', 'G1', 'c1']);
  assert.equal(a.channel, channel);
  const dm = createMessageAdapter({ author: { id: '42' }, channel: { id: 'dm9', send: async () => ({}) } });
  assert.deepEqual([dm.guild, dm.guildId, dm.channelId], [null, null, 'dm9'], 'sem channelId na mensagem, vale o id do canal');
  assert.equal(typeof dm.deferReply, 'function');
  assert.equal(dm.isChatInputCommand, undefined, 'continua sendo o adaptador de MENSAGEM (o ask.js se baseia nisto)');
});
await test('mensagem parcial (sem autor nem canal) não lança: os campos viram null', () => {
  const a = createMessageAdapter({});
  assert.deepEqual([a.user, a.authorId, a.guild, a.guildId, a.channelId, a.channel], [null, null, null, null, null, null]);
});
await test('o dono em DM pelo adaptador PURO (sem o buildPrefixAdapter) já é conversa sensível; outra pessoa não', async () => {
  const { isSensitiveInteraction } = await import('../src/discord/commands/ask.js');
  assert.equal(isSensitiveInteraction(createMessageAdapter({ author: { id: OWNER }, channelId: 'dm1', channel: { id: 'dm1' } })), true);
  assert.equal(isSensitiveInteraction(createMessageAdapter({ author: { id: '222' }, channelId: 'dm2', channel: { id: 'dm2' } })), false);
  assert.equal(isSensitiveInteraction(createMessageAdapter({ author: { id: OWNER }, guild: { id: 'g1' }, channelId: 'priv1', channel: { id: 'priv1' } })), true, 'canal privado do dono');
});
await test('o arquivo messageAdapter.js continua CRLF puro (sem LF solto, sem BOM)', () => {
  const b = fs.readFileSync(path.join(repoRoot, 'src/discord/messageAdapter.js'));
  let cr = 0; let lf = 0; let lone = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 13) cr++;
    if (b[i] === 10) { lf++; if (b[i - 1] !== 13) lone++; }
  }
  assert.ok(cr > 0 && cr === lf && lone === 0, `cr=${cr} lf=${lf} lfSolto=${lone}`);
  assert.notEqual(b[0], 0xef, 'sem BOM');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('B. /yui e +yui perguntar: Porta A (pré-rota), Portas C e D (promessa vazia e guarda final)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('o teste fixa o padrão do código: chave mestra ligada, guarda ligada, pré-rota desligada, privado desligado', async () => {
  const { readResearchConfig } = await import('../src/handlers/researchAgent.js');
  const cfg = readResearchConfig();
  assert.deepEqual([cfg.enabled, cfg.guard, cfg.preRoute, cfg.privateSearch], [true, 'on', false, 'off']);
});
await test('pré-rota LIGADA: o /yui "pesquise o preço do ps5 hoje" => nenhuma chamada à pergunta principal, 1 busca, resposta com fontes, no máximo 3 edições de progresso', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  const { it, modelCalls } = await yui({ text: PS5_ASK, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'Vou pesquisar isso!') });
  const out = finalText(it);
  assert.ok(isResearchAnswer(out), out);
  assert.ok(noPromise(out), out);
  assert.equal(modelCalls.filter((c) => !isSynthBody(c.body)).length, 0, 'a pergunta principal nem chegou ao modelo');
  assert.equal(modelCalls.length, 1, 'só a síntese');
  assert.equal(searches(), 1);
  assert.match(queryOf(0), /ps5/i);
  const lines = progressEdits(it);
  assert.ok(lines.length >= 1 && lines.length <= 3, `edições de progresso: ${lines.length}`);
  assert.ok(lines.some((l) => /Pesquisando/.test(l)), lines.join(' | '));
  assert.ok(it.deferred, 'a resposta foi adiada (deferReply) antes da pesquisa');
}));
await test('pré-rota DESLIGADA (padrão): o /yui segue o fluxo de SEMPRE — a busca automática antiga (generateResponse, Local/Gemini) pesquisa o pedido explícito e o modelo responde com o contexto; o agente não entra', async () => {
  const { it, modelCalls } = await yui({ text: PS5_ASK, script: () => 'O PS5 anda perto de R$ 3.800, mas confere na loja.' });
  const out = finalText(it);
  assert.match(out, /perto de R\$ 3\.800/);
  assert.equal(modelCalls.length, 1, 'uma chamada ao modelo (com o contexto da web), sem síntese do agente');
  assert.equal(searches(), 1, 'a busca automática antiga, exatamente como antes do agente');
  assert.ok(!out.includes('Fontes:'), 'o bloco de fontes é do agente');
  assert.ok(!logged(/\[Pesquisa\] tipo=/), 'o agente não rodou');
  assert.ok(lastUserOf(modelCalls[0].body).includes('[CONTEXTO OBTIDO NA WEB]'));
});
await test('Porta C: o /yui pede um dado atual SEM verbo de pesquisa e o modelo só promete ("Vou pesquisar isso!") => vira pesquisa de verdade (1 busca) e a promessa nunca chega à pessoa', async () => {
  for (const promise of ['Vou pesquisar isso!', 'Deixa eu dar uma olhada', 'Um segundo, já te respondo', 'Pesquisando...']) {
    const { it, modelCalls } = await yui({ text: 'quero saber o lançamento do Hytale', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : promise) });
    const out = finalText(it);
    assert.ok(isResearchAnswer(out), `${promise} => ${out}`);
    assert.equal(searches(), 1, promise);
    assert.equal(modelCalls.length, 2, 'a pergunta principal e a síntese');
    assert.ok(!contentsOf(it).some((c) => c === promise), 'a promessa nunca é entregue');
  }
});
await test('caso REAL de 14/10 pelo /yui: fala sem verbo de pesquisa + promessa do modelo => 1 busca com a consulta DA PROMESSA, resposta com fontes e nenhuma promessa visível', async () => {
  const promise = 'Vou buscar dados de preços de financiamento e manutenção no Rio de Janeiro pra te dar opções precisas.';
  const { it, modelCalls } = await yui({ text: 'yui rio de janeiro, parcelas de ate 900 e o uso rotineiro / trabalho', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : promise) });
  const out = finalText(it);
  assert.ok(isResearchAnswer(out), out);
  assert.equal(searches(), 1);
  assert.match(queryOf(0), /financiamento/i, `a consulta veio da promessa: ${queryOf(0)}`);
  assert.equal(modelCalls.length, 2);
  assert.ok(!contentsOf(it).some((c) => c.includes('Vou buscar dados')));
});
await test('caso REAL dos 45 mods pelo /yui: pedido grande + promessa => 0 buscas, UM pedido de resposta final ao modelo, promessa nunca entregue', async () => {
  const list = Array.from({ length: 45 }, (_, i) => `- mod numero ${i + 1} do curseforge`).join('\n');
  const { it, modelCalls } = await yui({ text: `yui pega o link de cada um destes mods no curseforge pra mim:\n${list}`, script: (n) => (n === 1 ? 'Vou pesquisar os links de cada mod no CurseForge e já te mando tudo!' : 'Não consigo abrir os links de todos de uma vez, mas me manda 3 ou 4 por vez que eu ajudo.') });
  assert.equal(searches(), 0);
  assert.equal(modelCalls.length, 2, 'a promessa + o pedido da resposta final');
  assert.match(finalText(it), /me manda 3 ou 4/);
  assert.ok(noPromise(finalText(it)));
});
await test('conversa comum NÃO vira pesquisa: "vou buscar meu café" passa como está (uma chamada ao modelo, 0 buscas)', async () => {
  const { it, modelCalls } = await yui({ text: 'oi yui', script: () => 'Ei, vou buscar meu café ☕' });
  assert.equal(finalText(it), 'Ei, vou buscar meu café ☕');
  assert.equal(searches(), 0);
  assert.equal(modelCalls.length, 1);
});
await test('pergunta de conhecimento + "Um segundo, já te respondo" => pede a resposta final ao modelo (1 vez), sem pesquisar; o pedido leva o contexto do /yui', async () => {
  const { it, modelCalls } = await yui({ text: 'me explica como funciona o rollback netcode', script: (n) => (n === 1 ? 'Um segundo, já te respondo' : 'Rollback netcode prevê os inputs e corrige quando os reais chegam.') });
  assert.match(finalText(it), /Rollback netcode prevê/);
  assert.equal(searches(), 0);
  assert.equal(modelCalls.length, 2);
  assert.ok(lastUserOf(modelCalls[1].body).includes('Responda AGORA'), 'o segundo pedido é o da resposta final (sem promessa)');
});
await test('Porta D: o modelo SÓ promete, sempre => a promessa nunca é entregue sozinha ("Desculpe, tive um erro..."), 0 buscas', async () => {
  const { it } = await yui({ text: 'me explica como funciona o rollback netcode', script: () => 'Um segundo, já te respondo' });
  assert.match(finalText(it), /Desculpe, tive um erro ao fechar essa resposta/);
  assert.equal(searches(), 0);
  assert.ok(noPromise(finalText(it)));
});
await test('YUI_RESEARCH_ENABLED=false (chave mestra): nem a pré-rota nem a recuperação pesquisam; a guarda final continua trocando a promessa pelo aviso', () => withEnv({ YUI_RESEARCH_ENABLED: 'false', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  const a = await yui({ text: PS5_ASK, script: () => 'O PS5 custa uns R$ 3.800.' });
  assert.match(finalText(a.it), /R\$ 3\.800/);
  assert.ok(!finalText(a.it).includes('Fontes:') && !logged(/\[Pesquisa\] tipo=/), 'o agente não roda (a busca antiga do generateResponse é que pesquisa)');
  assert.equal(a.modelCalls.length, 1, 'a pré-rota não roda: o modelo responde');
  const b = await yui({ text: 'quero saber o lançamento do Hytale', script: () => 'Vou pesquisar isso!' });
  assert.equal(searches(), 0);
  assert.match(finalText(b.it), /Desculpe, tive um erro ao fechar essa resposta/);
  assert.equal(b.modelCalls.length, 1, 'sem recuperação nem nova resposta');
}));
await test('YUI_RESEARCH_GUARD=observe: a resposta NÃO muda (a promessa sai como veio), nenhuma busca; só saem linhas de metadados. GUARD=off: nem isso', async () => {
  await withEnv({ YUI_RESEARCH_GUARD: 'observe' }, async () => {
    const { it } = await yui({ text: 'quero saber o lançamento do Hytale', script: () => 'Vou pesquisar isso!' });
    assert.equal(finalText(it), 'Vou pesquisar isso!');
    assert.equal(searches(), 0);
    assert.ok(logged(/\[Pesquisa\] guarda \(observe\): acao=search/), logLines.join('\n'));
    assert.ok(logged(/guarda final \(observe\): trocaria a resposta/));
    assert.ok(!logLines.some((l) => /hytale/i.test(l)), 'sem o texto da pessoa no log');
  });
  await withEnv({ YUI_RESEARCH_GUARD: 'off' }, async () => {
    const { it } = await yui({ text: 'quero saber o lançamento do Hytale', script: () => 'Vou pesquisar isso!' });
    assert.equal(finalText(it), 'Vou pesquisar isso!');
    assert.equal(searches(), 0);
    assert.ok(!logged(/\[Pesquisa\] guarda/), 'guarda desligada: nada no log');
  });
});
await test('pesquisa SEM resultado pelo /yui (pré-rota ligada): mensagem honesta com o motivo, nunca a promessa nem silêncio', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  const { it } = await yui({ text: SEARCH_ASK, search: 'empty', script: () => 'nunca deveria chegar ao modelo' });
  const out = finalText(it);
  assert.ok(out.length > 20 && noPromise(out), out);
  assert.ok(!isResearchAnswer(out));
  assert.ok(searches() >= 1);
  resetCooldowns();
}));
await test('limite por usuário (5 por hora) no /yui: a 6ª pesquisa recebe o pedido para esperar e nem chega ao buscador (D1, D2)', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  const budget = getDefaultBudget();
  for (let i = 0; i < 5; i++) budget.takeUser('u-lim');
  const { it } = await yui({ text: SEARCH_ASK, userId: 'u-lim', script: () => 'nunca deveria chegar ao modelo' });
  assert.equal(searches(), 0, 'o limite barrou antes do buscador');
  assert.match(finalText(it), /limite|esperar|hora/i);
  assert.ok(noPromise(finalText(it)));
  getDefaultBudget().reset();
  resetCooldowns();
}));
await test('ferramenta search_web DESLIGADA no servidor: o /yui responde que a pesquisa está desativada (nunca promete); com a pré-rota ou pela promessa', async () => {
  const llm = await import('../src/handlers/llmHandler.js');
  llm.setServerToolEnabled('g-off', 'search_web', false);
  try {
    await withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
      const a = await yui({ text: SEARCH_ASK, guildId: 'g-off', script: () => 'nem deveria chegar ao modelo' });
      assert.equal(finalText(a.it), 'A pesquisa na web está desativada neste servidor.');
      assert.equal(a.modelCalls.length, 0);
    });
    const b = await yui({ text: 'quero saber o lançamento do Hytale', guildId: 'g-off', script: () => 'Vou pesquisar isso!' });
    assert.equal(finalText(b.it), 'A pesquisa na web está desativada neste servidor.');
    assert.equal(searches(), 0);
  } finally {
    llm.setServerToolEnabled('g-off', 'search_web', true);
  }
});
await test('cotação: "vou ver o dólar" a um pedido de cotação vira a conversão (convert_currency), não uma pesquisa', async () => {
  const { it } = await yui({ text: 'quanto está o dólar hoje? pesquisa pra mim', script: () => 'Vou ver a cotação do dólar pra você!' });
  const out = finalText(it);
  assert.equal(searches(), 0);
  assert.ok(noPromise(out), out);
});

section('B2. Conversa PRIVADA no /yui (o dono em DM): YUI_PRIVATE_SEARCH e as proteções do modo privado');
const yuiPrivate = (over) => yui({ userId: OWNER, guildId: null, channelId: 'dm-priv', ...over }); // DM do dono: memoryScope "personal" => conversa sensível
await test('privado DESLIGADO (padrão): recusa imediata e honesta, 0 buscas; com a pré-rota nem consulta o modelo; promessa também vira a recusa', async () => {
  const a = await yuiPrivate({ text: PS5_ASK, script: () => 'Vou pesquisar isso!' });
  assert.equal(finalText(a.it), 'Não pesquiso na web numa conversa privada.');
  assert.equal(searches(), 0);
  await withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
    const b = await yuiPrivate({ text: PS5_ASK, script: () => 'nem deveria chegar ao modelo' });
    assert.equal(finalText(b.it), 'Não pesquiso na web numa conversa privada.');
    assert.equal(b.modelCalls.length, 0, 'com a pré-rota a recusa vem antes de qualquer chamada ao modelo');
    assert.equal(searches(), 0);
    assert.equal(progressEdits(b.it).length, 0, 'sem progresso na recusa');
  });
  const c = await yuiPrivate({ text: PS5_ASK, script: () => 'O PS5 custa uns R$ 3.800.' });
  assert.match(finalText(c.it), /R\$ 3\.800/, 'resposta comum do modelo (sem promessa) segue como sempre');
  assert.equal(searches(), 0);
});
await test('privado LIBERADO (all) e o modelo responde "de cabeça": o /yui não tem ferramentas, então o código pesquisa o pedido explícito; consulta SÓ da fala literal; síntese sem histórico, sem anônimos; nada da consulta no log nem no progresso', () => withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
  resetCooldowns();
  const synthBodies = [];
  const { it, modelCalls } = await yuiPrivate({ text: PS5_ASK, script: (n, body) => { if (isSynthBody(body)) { synthBodies.push(body); return SYNTH_ANSWER; } return 'O PS5 custa uns R$ 3.800.'; } });
  const out = finalText(it);
  assert.ok(isResearchAnswer(out), out);
  assert.equal(searches(), 1);
  assert.match(queryOf(0), /ps5/i);
  assert.equal(modelCalls.length, 2);
  assert.equal(synthBodies.length, 1);
  assert.equal(synthBodies[0].messages.length, 2, 'a síntese vê só o prompt de sistema e a pergunta com a evidência (sem histórico)');
  assert.equal(synthBodies[0].tools, undefined);
  assert.equal(calls.filter(isPollinations).length + calls.filter(isHorde).length, 0, 'nenhum provedor anônimo');
  assert.ok(!logLines.some((l) => /ps5/i.test(l)), `a consulta apareceu no log: ${logLines.filter((l) => /ps5/i.test(l)).join(' | ')}`);
  assert.ok(!progressEdits(it).some((l) => /ps5/i.test(l)), 'o progresso não mostra a consulta');
  assert.ok(progressEdits(it).some((l) => /Pesquisando…/.test(l)));
  resetCooldowns();
}));
await test('privado LIBERADO e a promessa do modelo cita dado pessoal: a consulta NUNCA vem da promessa, só do texto literal da mensagem', () => withEnv({ YUI_PRIVATE_SEARCH: 'owner' }, async () => {
  resetCooldowns();
  const { it } = await yuiPrivate({ text: PS5_ASK, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'Vou pesquisar o preço do ps5 para Zeferino em Niterói, rua das Flores!') });
  assert.ok(isResearchAnswer(finalText(it)), finalText(it));
  assert.equal(searches(), 1);
  assert.ok(!/zeferino|niter|flores/i.test(queryOf(0)), `a consulta levou dado da promessa: ${queryOf(0)}`);
  assert.match(queryOf(0), /ps5/i);
  resetCooldowns();
}));
await test('privado LIBERADO mas o pedido NÃO é explícito: não pesquisa; a promessa vira a resposta final sem pesquisa', () => withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
  const a = await yuiPrivate({ text: 'me fala do preço do ps5 hoje', script: (n) => (n === 1 ? 'Vou pesquisar isso!' : 'Não sei dizer o preço de hoje.') });
  assert.match(finalText(a.it), /Não sei dizer/);
  assert.equal(searches(), 0);
  const b = await yuiPrivate({ text: 'me fala do preço do ps5 hoje', script: () => 'O PS5 anda perto de R$ 3.800.' });
  assert.match(finalText(b.it), /perto de R\$ 3\.800/, 'resposta comum fica como está');
  assert.equal(searches(), 0);
}));
await test('privado: e-mail, CPF, telefone e token na fala NÃO saem para o buscador (pedem para reescrever); palavra proibida do banHandler também', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  const samples = [
    'pesquise o email joao@exemplo.com do meu amigo',
    'pesquise o cpf 123.456.789-09 dessa pessoa',
    'pesquise o telefone (21) 98877-6655 dessa loja',
    'pesquise esse token sk-abcdefghijklmnopqrstuvwxyz123456',
  ];
  for (const text of samples) {
    const a = await yuiPrivate({ text, script: () => 'nem deveria chegar ao modelo' });
    assert.equal(searches(), 0, text);
    assert.match(finalText(a.it), /dado pessoal ou segredo/, finalText(a.it));
    const b = await yui({ text, script: () => 'nem deveria chegar ao modelo' });
    assert.equal(searches(), 0, `público: ${text}`);
    assert.match(finalText(b.it), /dado pessoal ou segredo/);
  }
  const forb = await yuiPrivate({ text: 'pesquise sobre tortura medieval hoje', script: () => 'nem deveria chegar ao modelo' });
  assert.equal(searches(), 0);
  assert.match(finalText(forb.it), /Não consigo pesquisar isso/);
}));
await test('contexto por horas: a troca de uma pesquisa (pública e privada) NÃO é gravada; a troca comum é (controle)', () => withEnv({ YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  const seenFor = async (userId, channelId, guildId) => {
    const target = resolveContextTarget({ userId, channelId, guildId, personal: userId === OWNER && !guildId, record: true, userText: 'x' });
    return readContextTurns(target, { sensitive: true }).map((t) => `${t.role}:${t.content}`).join('\n');
  };
  // público
  await yui({ text: 'oi yui, tudo bem?', userId: 'u-c1', channelId: 'ch-c1', script: () => 'Tudo ótimo por aqui!' });
  await yui({ text: SEARCH_ASK, userId: 'u-c1', channelId: 'ch-c1', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'não deveria chegar') });
  const pub = await seenFor('u-c1', 'ch-c1', 'g1');
  assert.ok(pub.includes('Tudo ótimo por aqui!'), `controle: a troca comum foi gravada: ${pub}`);
  assert.ok(!/Hytale|Fontes|R\$ 900|exemplo\.test/i.test(pub), `a troca da pesquisa foi gravada: ${pub}`);
  // privado (dono em DM)
  await yuiPrivate({ text: 'oi yui, tudo bem?', channelId: 'dm-c2', script: () => 'Oi, dono!' });
  await yuiPrivate({ text: PS5_ASK, channelId: 'dm-c2', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'não deveria chegar') });
  const priv = await seenFor(OWNER, 'dm-c2', null);
  assert.ok(priv.includes('Oi, dono!'), `controle privado: ${priv}`);
  assert.ok(!/ps5|Fontes|R\$ 900|exemplo\.test/i.test(priv), `a pesquisa privada foi gravada: ${priv}`);
  resetCooldowns();
}));
await test('contexto por horas: a promessa trocada pelo aviso (guarda final) é gravada como erro da IA, nunca como fala da Yui', () => withEnv({ YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all' }, async () => {
  await yui({ text: 'me explica como funciona o rollback netcode', userId: 'u-c3', channelId: 'ch-c3', script: () => 'Um segundo, já te respondo' });
  const target = resolveContextTarget({ userId: 'u-c3', channelId: 'ch-c3', guildId: 'g1', personal: false, record: true, userText: 'x' });
  const turns = readContextTurns(target, { sensitive: true }).map((t) => t.content).join('\n');
  assert.ok(!/Um segundo, já te respondo/.test(turns), turns);
}));

section('B3. "+yui perguntar": o adaptador traz QUEM pediu e ONDE (limite por pessoa, conversa sensível)');
await test('+yui perguntar com a pré-rota: pesquisa pelo mesmo agente e edita a mensagem "Processando..." com a resposta e as fontes', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  const { final, m, modelCalls } = await prefixYui({ text: SEARCH_ASK, authorId: 'p-a1', guildId: 'g1', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'Vou pesquisar isso!') });
  assert.ok(isResearchAnswer(final), final);
  assert.equal(searches(), 1);
  assert.equal(modelCalls.length, 1, 'só a síntese');
  assert.equal(m.sent.length >= 1 && /Processando/.test(m.sent[0]), true, 'a mensagem "Processando..." do deferReply');
  assert.ok(!m.replies.some((r) => /erro interno/.test(String(r?.content ?? r))));
}));
await test('Q43 o DONO em DM pelo +yui perguntar recebe a recusa da conversa privada (antes: o adaptador sem user/channelId deixava pesquisar); pré-rota ou promessa', async () => {
  await withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
    const a = await prefixYui({ text: PS5_ASK, authorId: OWNER, channelId: 'dm-pfx', script: () => 'nem deveria chegar ao modelo' });
    assert.equal(a.final, 'Não pesquiso na web numa conversa privada.');
    assert.equal(searches(), 0);
    assert.equal(a.modelCalls.length, 0);
  });
  const b = await prefixYui({ text: PS5_ASK, authorId: OWNER, channelId: 'dm-pfx', script: () => 'Vou pesquisar isso!' });
  assert.equal(b.final, 'Não pesquiso na web numa conversa privada.');
  assert.equal(searches(), 0);
  // outra pessoa na DM: não é a conversa PESSOAL do dono (memória pública), mas para a PESQUISA a DM de qualquer pessoa é privada ("DM e app para todos, com as
  // proteções"): com YUI_PRIVATE_SEARCH=off recusa; com "all" pesquisa (consulta literal, síntese sem provedor anônimo, nada gravado)
  await withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
    const c = await prefixYui({ text: PS5_ASK, authorId: 'p-bob', channelId: 'dm-bob', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
    assert.equal(c.final, 'Não pesquiso na web numa conversa privada.');
    assert.equal(searches(), 0);
  });
  await withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true', YUI_PRIVATE_SEARCH: 'all' }, async () => {
    const d = await prefixYui({ text: PS5_ASK, authorId: 'p-bob', channelId: 'dm-bob', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
    assert.ok(isResearchAnswer(d.final), d.final);
    assert.equal(searches(), 1);
  });
});
await test('Q28 +yui perguntar repetido: o limite de buscas POR PESSOA vale (5 por hora); a 6ª não chega ao buscador (antes: 7 buscas em 7 pedidos)', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  let total = 0;
  for (let i = 1; i <= 6; i++) {
    const r = await prefixYui({ text: `pesquise sobre o lançamento do jogo número ${i}`, authorId: 'p-rep', channelId: 'chan-rep', guildId: 'g1', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
    total += searches();
    if (i <= 5) assert.ok(isResearchAnswer(r.final), `${i}: ${r.final}`);
    else assert.ok(!isResearchAnswer(r.final) && searches() === 0, `6ª: ${r.final}`);
  }
  assert.equal(total, 5, 'cinco buscas no total');
  getDefaultBudget().reset();
  resetCooldowns();
}));
await test('Q36 duas perguntas do mesmo usuário ao mesmo tempo: a 2ª é recusada (efêmera, antes de adiar) e a trava é liberada no fim; outra pessoa passa', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  resetRun();
  installModel((n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x'));
  let open;
  const hold = new Promise((r) => { open = r; });
  searchHook = async (u) => { await hold; const q = new URL(u).searchParams.get('q') ?? ''; return jsonResp({ results: searxResults(q) }); };
  const first = fakeSlash({ userId: 'u-lock', channelId: 'chan-lock', pergunta: SEARCH_ASK });
  const p1 = askCommand.execute(first);
  try {
    for (let i = 0; i < 100 && searches() < 1; i++) await sleep(20);
    assert.equal(searches(), 1, 'a 1ª pesquisa chegou ao buscador e está parada nele');
    const second = fakeSlash({ userId: 'u-lock', channelId: 'chan-lock', pergunta: 'pesquise outra coisa qualquer' });
    await askCommand.execute(second);
    assert.equal(second.deferred, false, 'a recusa vem ANTES do deferReply');
    assert.match(String(second.replies[0]?.content), /Espere a resposta anterior/);
    assert.equal(second.replies[0].ephemeral, true);
    assert.equal(searches(), 1, 'a recusa não busca nada');
  } finally {
    open(); // mesmo se uma asserção falhar, a pesquisa presa termina e devolve a vaga
  }
  await p1;
  assert.ok(isResearchAnswer(finalText(first)), finalText(first));
  const third = await yui({ text: SEARCH_ASK, userId: 'u-lock', channelId: 'chan-lock', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
  assert.ok(isResearchAnswer(finalText(third.it)), 'a trava foi liberada');
  resetCooldowns();
}));
await test('Q36 a trava é liberada MESMO quando a entrega falha (erro): o pedido seguinte da mesma pessoa não é recusado', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  const bad = await yui({ text: SEARCH_ASK, userId: 'u-err', channelId: 'chan-err', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x'), slashOpts: { failEdit: true, failFollowUp: true } });
  assert.equal(finalText(bad.it), '', 'nada foi entregue (a edição, o followUp e o canal falharam)');
  const next = await yui({ text: SEARCH_ASK, userId: 'u-err', channelId: 'chan-err', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
  assert.ok(isResearchAnswer(finalText(next.it)), 'sem "Espere a resposta anterior"');
  assert.ok(!next.it.replies.length);
  resetCooldowns();
}));
await test('pesquisas simultâneas FORA da fila: no máximo 2 no total (3 pessoas ao mesmo tempo => a 3ª recebe o aviso de ocupado e SEM buscar); as vagas voltam no fim', () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  resetRun();
  installModel((n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x'));
  let open;
  const hold = new Promise((r) => { open = r; });
  searchHook = async (u) => { await hold; const q = new URL(u).searchParams.get('q') ?? ''; return jsonResp({ results: searxResults(q) }); };
  const its = ['u-g1', 'u-g2', 'u-g3'].map((u, i) => fakeSlash({ userId: u, channelId: `chan-g${i}`, pergunta: `pesquise sobre o assunto numero ${i + 1} do momento` }));
  const runs = [askCommand.execute(its[0]), askCommand.execute(its[1])];
  try {
    for (let i = 0; i < 100 && searches() < 2; i++) await sleep(20);
    assert.equal(searches(), 2);
    assert.equal(manager.researchSlots.size(), 2, 'as duas vagas estão ocupadas');
    await askCommand.execute(its[2]);
    assert.equal(finalText(its[2]), manager.RESEARCH_BUSY_REPLY);
    assert.equal(searches(), 2, 'a 3ª nem chegou ao buscador');
  } finally {
    open(); // mesmo se uma asserção falhar, as pesquisas presas terminam e devolvem as vagas
  }
  await Promise.all(runs);
  assert.ok(isResearchAnswer(finalText(its[0])) && isResearchAnswer(finalText(its[1])));
  assert.equal(manager.researchSlots.size(), 0, 'as vagas foram devolvidas');
  const again = await yui({ text: SEARCH_ASK, userId: 'u-g3', channelId: 'chan-g3', script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
  assert.ok(isResearchAnswer(finalText(again.it)));
  resetCooldowns();
}));
await test('entrega PARCIAL (as partes 2+ não saem): o /yui NÃO lança e não troca a parte 1 por "❌ Não consigo te responder agora"', async () => {
  const long = Array.from({ length: 70 }, (_, i) => `Linha ${i + 1} da resposta longa com bastante texto para ocupar espaço no Discord.`).join('\n');
  const { it } = await yui({ text: 'me conta uma história bem longa', script: () => long, slashOpts: { failFollowUp: true } });
  const texts = contentsOf(it);
  assert.ok(texts.length >= 1);
  assert.ok(!texts.some((t) => /Não consigo te responder agora/.test(t)), texts.map((t) => t.slice(0, 80)).join(' | '));
  assert.ok(texts.some((t) => /Linha 1 da resposta/.test(t)), 'a parte 1 foi entregue');
  assert.ok(texts.some((t) => /Não consegui enviar as partes/.test(t)), `e leva o aviso honesto das partes que faltaram: ${texts.map((t) => `[${t.length}] ...${t.slice(-90)}`).join(' | ')}`);
  assert.ok(logged(/parcial=sim/), 'a linha de entrega diz "parcial=sim"');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('B4. Correções da revisão: /yui sem busca repetida, com a web reaproveitada, sem JSON cru, com o interruptor do servidor e na DM de qualquer pessoa');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('3a/K4 /yui: a busca automática NÃO deu resultado e o modelo prometeu pesquisar mesmo assim: nenhuma 2ª busca (antes eram 3 buscas e 3 unidades de cota); o usuário recebe o motivo', async () => {
  resetCooldowns();
  const control = await yui({ text: PS5_ASK, search: 'empty', userId: 'u-3a-c', script: () => 'Não achei nada, mas sigo com o que sei.' });
  const baseline = searches();
  assert.ok(baseline >= 1, 'a busca automática rodou');
  assert.match(finalText(control.it), /sigo com o que sei/);
  resetCooldowns();
  const { it } = await yui({ text: PS5_ASK, search: 'empty', userId: 'u-3a', script: () => 'Vou pesquisar isso!' });
  assert.equal(searches(), baseline, `buscas: ${searches()} (a automática sozinha faz ${baseline})`);
  assert.match(finalText(it), /Não achei nada útil/);
  assert.ok(noPromise(finalText(it)), finalText(it));
  assert.ok(!logged(/\[Pesquisa\] tipo=/), 'o agente não pesquisou de novo');
});
await test('3d /yui: a busca automática trouxe a web e a síntese só prometeu ("vou analisar..."): nova resposta COM a mesma web, sem 2ª busca e sem o pedido de desculpas', async () => {
  resetCooldowns();
  const { it, modelCalls } = await yui({ text: PS5_ASK, userId: 'u-3d', script: (n) => (n === 1 ? 'Vou analisar os resultados e já te respondo!' : 'O PS5 anda perto de R$ 3.800, segundo as fontes.') });
  const out = finalText(it);
  assert.match(out, /perto de R\$ 3\.800/);
  assert.ok(!/Desculpe, tive um erro/.test(out), out);
  assert.equal(searches(), 1, 'só a busca automática');
  assert.equal(modelCalls.length, 2);
  assert.ok(lastUserOf(modelCalls[1].body).includes('[CONTEXTO OBTIDO NA WEB]'), 'a nova resposta recebeu a mesma web');
  assert.ok(lastUserOf(modelCalls[1].body).includes('[DADOS EXTERNOS NÃO CONFIÁVEIS'), 'cercada como dado não confiável');
});
await test('3b /yui: JSON de ferramenta cru ({"tool":...}, {}) nunca é a resposta: o pedido de desculpas honesto no lugar', async () => {
  for (const raw of ['{"tool":"search_game"}', '{}']) {
    const { it } = await yui({ text: 'oi yui, tudo bem?', userId: `u-3b-${raw.length}`, script: () => raw });
    const out = finalText(it);
    assert.ok(!out.includes('{'), out);
    assert.match(out, /Desculpe, tive um erro ao montar essa resposta/);
  }
});
await test('3c /yui: search_web desligada no servidor: a busca automática não roda, nem para o pedido explícito', async () => {
  const llm = await import('../src/handlers/llmHandler.js');
  llm.setServerToolEnabled('g-off-y2', 'search_web', false);
  try {
    const { it } = await yui({ text: PS5_ASK, guildId: 'g-off-y2', userId: 'u-3c', script: () => 'Não tenho como confirmar isso agora.' });
    assert.equal(searches(), 0);
    assert.match(finalText(it), /Não tenho como confirmar/);
    const p = await yui({ text: PS5_ASK, guildId: 'g-off-y2', userId: 'u-3c2', script: () => 'Vou pesquisar isso!' });
    assert.equal(searches(), 0);
    assert.ok(noPromise(finalText(p.it)), finalText(p.it));
  } finally {
    llm.setServerToolEnabled('g-off-y2', 'search_web', true);
  }
});
await test('P1 /yui na DM de um MEMBRO: com YUI_PRIVATE_SEARCH=off recusa (a busca automática não roda); com "all" pesquisa só o pedido literal, com as proteções do privado', async () => {
  resetCooldowns();
  const off = await yui({ text: PS5_ASK, userId: 'bob-dm1', guildId: null, channelId: 'dm-bob-y1', script: () => 'Vou pesquisar isso!' });
  assert.equal(finalText(off.it), 'Não pesquiso na web numa conversa privada.');
  assert.equal(searches(), 0);
  const noAuto = await yui({ text: PS5_ASK, userId: 'bob-dm1', guildId: null, channelId: 'dm-bob-y1', script: () => 'O PS5 custa uns R$ 3.800.' });
  assert.equal(searches(), 0, 'a busca automática antiga não roda na DM (era assim só para o dono)');
  assert.match(finalText(noAuto.it), /R\$ 3\.800/);
  await withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
    resetCooldowns();
    const synthBodies = [];
    const { it } = await yui({ text: 'pesquise o preço do ps5 hoje porque estou juntando dinheiro pro divórcio', userId: 'bob-dm2', guildId: null, channelId: 'dm-bob-y2',
      script: (n, body) => { if (isSynthBody(body)) { synthBodies.push(body); return SYNTH_ANSWER; } return 'O PS5 custa uns R$ 3.800.'; } });
    const out = finalText(it);
    assert.ok(isResearchAnswer(out), out);
    assert.equal(searches(), 1);
    assert.ok(!/divórcio|divorcio|porque/i.test(queryOf(0)), `consulta: ${queryOf(0)}`);
    assert.equal(synthBodies[0].messages.length, 2);
    assert.equal(calls.filter(isPollinations).length + calls.filter(isHorde).length, 0, 'nenhum provedor anônimo');
    assert.ok(!logLines.some((l) => /ps5|exemplo\.test/i.test(l)), 'a consulta ou o host apareceu no log');
  });
});
await test('privado LIBERADO (all), pergunta factual SEM pedido explícito e o modelo promete: NÃO pesquisa, o código pede a resposta final (lacuna do teste de mutação do verificador)', () => withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
  const { it, modelCalls } = await yuiPrivate({ text: 'qual o preço do ps5 hoje?', script: (n) => (n === 1 ? 'Vou pesquisar isso!' : 'Não sei dizer o preço de hoje, mas costuma ficar perto de R$ 3.800.') });
  assert.equal(searches(), 0);
  assert.equal(modelCalls.length, 2);
  assert.match(finalText(it), /costuma ficar perto de R\$ 3\.800/);
  assert.ok(!/só pesquiso se você pedir/.test(finalText(it)), 'não foi o agente que respondeu');
}));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('C. APP / API: o mesmo agente (POST /v1/chat e POST /v1/agent), com o YUI_PRIVATE_SEARCH aplicado');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const OWNER_TOKEN = 'owner-token-0123456789';
const MEMBER_TOKEN = 'member-token-0123456789';
const servers = [];
async function startApp() {
  const server = createApiServer({ tokens: parseTokens(`${OWNER_TOKEN}=${OWNER},${MEMBER_TOKEN}=222`) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;
  const call = (method, route, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: route, agent: false, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch { /* fica null */ } resolve({ status: res.statusCode, json, raw }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { server, call };
}
const app = await startApp();
/** Uma conversa do app: devolve a resposta e as chamadas ao modelo. route: 'chat' (POST /v1/chat) ou 'agent' (POST /v1/agent, a que o app usa). */
async function appSay({ text, token = OWNER_TOKEN, route = 'agent', script, search = 'hit', fresh = false }) {
  resetRun(search);
  installModel(script);
  const a = fresh ? await startApp() : app;
  const r = await a.call('POST', route === 'agent' ? '/v1/agent' : '/v1/chat', { token, body: { message: text } });
  assert.equal(r.status, 200, r.raw);
  await sleep(60);
  return { reply: String(r.json?.reply ?? ''), json: r.json, modelCalls: calls.filter((c) => c.url === URL_GROQ), a };
}
for (const route of ['agent', 'chat']) {
  await test(`app (${route}) com a pré-rota e o privado LIBERADO (all): 1 busca, resposta com fontes, a pergunta principal nem chega ao modelo; consulta SÓ da fala; sem anônimos; nada da consulta no log`, () => withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true', YUI_PRIVATE_SEARCH: 'all' }, async () => {
    resetCooldowns();
    getDefaultBudget().reset();
    const synthBodies = [];
    const { reply, json, modelCalls } = await appSay({ text: PS5_ASK, route, fresh: true, script: (n, body) => { if (isSynthBody(body)) { synthBodies.push(body); return SYNTH_ANSWER; } return 'Vou pesquisar isso!'; } });
    assert.ok(isResearchAnswer(reply), reply);
    assert.equal(searches(), 1);
    assert.match(queryOf(0), /ps5/i);
    assert.equal(modelCalls.length, 1, 'só a síntese');
    assert.equal(synthBodies[0].messages.length, 2, 'a síntese vê só o prompt de sistema e a pergunta com a evidência (sem histórico nem memória)');
    assert.equal(synthBodies[0].tools, undefined);
    assert.equal(calls.filter(isPollinations).length + calls.filter(isHorde).length, 0, 'nenhum provedor anônimo');
    assert.ok(!logLines.some((l) => /ps5/i.test(l)), `a consulta apareceu no log: ${logLines.filter((l) => /ps5/i.test(l)).join(' | ')}`);
    if (route === 'agent') assert.equal(json.type, 'reply');
    else assert.equal(json.memoryScope, 'personal');
    resetCooldowns();
  }));
}
await test('app: o contrato das respostas não mudou (chat => {reply, memoryScope}; agent => {type:"reply", reply})', async () => {
  const c = await appSay({ text: 'oi yui', route: 'chat', fresh: true, script: () => 'Oi!' });
  assert.deepEqual(Object.keys(c.json).sort(), ['memoryScope', 'reply']);
  assert.equal(c.reply, 'Oi!');
  const a = await appSay({ text: 'oi yui', route: 'agent', fresh: true, script: () => 'Oi de novo!' });
  assert.equal(a.json.type, 'reply');
  assert.equal(a.reply, 'Oi de novo!');
  assert.equal(searches(), 0);
});
await test('app com o privado DESLIGADO (padrão do código): recusa imediata e honesta, 0 buscas, 0 chamadas ao modelo (pré-rota); promessa também vira a recusa', async () => {
  for (const route of ['agent', 'chat']) {
    await withEnv({ YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
      const a = await appSay({ text: PS5_ASK, route, fresh: true, script: () => 'nem deveria chegar ao modelo' });
      assert.equal(a.reply, 'Não pesquiso na web numa conversa privada.');
      assert.equal(a.modelCalls.length, 0);
      assert.equal(searches(), 0);
    });
    const b = await appSay({ text: PS5_ASK, route, fresh: true, script: () => 'Vou pesquisar isso!' });
    assert.equal(b.reply, 'Não pesquiso na web numa conversa privada.');
    assert.equal(searches(), 0);
    assert.equal(b.modelCalls.length, 1);
  }
});
await test('app: com "owner" só o DONO pesquisa; o membro continua recusado; com "all" o membro também pesquisa (as proteções são as mesmas)', async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  const script = (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'Vou pesquisar isso!');
  await withEnv({ YUI_PRIVATE_SEARCH: 'owner', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
    const member = await appSay({ text: PS5_ASK, token: MEMBER_TOKEN, fresh: true, script });
    assert.equal(member.reply, 'Não pesquiso na web numa conversa privada.');
    assert.equal(searches(), 0);
    const owner = await appSay({ text: PS5_ASK, token: OWNER_TOKEN, fresh: true, script });
    assert.ok(isResearchAnswer(owner.reply), owner.reply);
    assert.equal(searches(), 1);
  });
  await withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
    const member = await appSay({ text: PS5_ASK, token: MEMBER_TOKEN, fresh: true, script });
    assert.ok(isResearchAnswer(member.reply), member.reply);
    assert.equal(searches(), 1);
  });
  getDefaultBudget().reset();
  resetCooldowns();
});
await test('Q29 app SEM pré-rota e o modelo só promete => pesquisa de verdade (Porta C); e o pedido explícito respondido "de cabeça" também é pesquisado (o app não tem ferramentas)', () => withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  const promise = await appSay({ text: SEARCH_ASK, fresh: true, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'Vou pesquisar isso!') });
  assert.ok(isResearchAnswer(promise.reply), promise.reply);
  assert.equal(searches(), 1);
  assert.equal(promise.modelCalls.length, 2);
  const memory = await appSay({ text: PS5_ASK, fresh: true, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'O PS5 custa uns R$ 3.800.') });
  assert.ok(isResearchAnswer(memory.reply), memory.reply);
  assert.equal(searches(), 1);
  assert.ok(!/R\$ 3\.800/.test(memory.reply), 'o chute do modelo não substitui a pesquisa');
  // conversa comum não vira pesquisa
  const chat = await appSay({ text: 'oi yui, tudo bem?', fresh: true, script: () => 'Tudo ótimo por aqui!' });
  assert.equal(chat.reply, 'Tudo ótimo por aqui!');
  assert.equal(searches(), 0);
  getDefaultBudget().reset();
  resetCooldowns();
}));
await test('app: "pesquise o arquivo X" / "procura nas minhas pastas" são das ferramentas LOCAIS do agente: nunca vão à web (nem pela pré-rota nem pelo código); "pesquise o preço da RAM" continua web', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  for (const text of ['pesquise o arquivo relatorio-final.docx', 'procura nas minhas pastas o contrato do aluguel', 'pesquise no meu pc o projeto bds', 'busque a pasta de fotos do verão']) {
    for (const route of ['agent', 'chat']) {
      const r = await appSay({ text, route, fresh: true, script: () => 'Não achei esse arquivo aqui.' });
      assert.equal(searches(), 0, `${route}: ${text}`);
      assert.equal(r.reply, 'Não achei esse arquivo aqui.', 'o modelo/agente de ferramentas é quem responde');
      assert.equal(r.modelCalls.length, 1);
    }
  }
  // a promessa do modelo num pedido local também não vira busca na web: pede a resposta final
  const p = await appSay({ text: 'pesquise o arquivo relatorio-final.docx', fresh: true, script: (n) => (n === 1 ? 'Vou pesquisar isso!' : 'Esse arquivo eu não consigo achar daqui.') });
  assert.equal(searches(), 0);
  assert.match(p.reply, /não consigo achar/);
  // controle: pedido de web com palavras parecidas continua sendo pesquisa
  const web = await appSay({ text: 'pesquise o preço da ram ddr5 hoje', fresh: true, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
  assert.ok(isResearchAnswer(web.reply), web.reply);
  assert.equal(searches(), 1);
  resetCooldowns();
}));
await test('app: privado liberado mas o pedido NÃO é explícito => não pesquisa; a promessa vira a resposta final; se o modelo promete DE NOVO, a guarda final diz que não deu para pesquisar (honesta)', () => withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
  const a = await appSay({ text: 'me fala do preço do ps5 hoje', fresh: true, script: (n) => (n === 1 ? 'Vou pesquisar isso!' : 'Não sei dizer o preço de hoje.') });
  assert.match(a.reply, /Não sei dizer/);
  assert.equal(searches(), 0);
  const b = await appSay({ text: 'quero saber o lançamento do Hytale', fresh: true, script: () => 'Vou pesquisar isso!' });
  assert.equal(b.reply, manager.APP_NO_SEARCH_REPLY);
  assert.equal(searches(), 0);
  assert.equal(b.modelCalls.length, 2, 'a promessa e UM pedido de resposta final');
  const c = await appSay({ text: 'me explica como funciona o rollback netcode', fresh: true, script: () => 'Um segundo, já te respondo' });
  assert.match(c.reply, /Desculpe, tive um erro ao fechar essa resposta/, 'sem pedido de pesquisa: o aviso de sempre');
}));
await test('app: e-mail, CPF, telefone e token na fala NÃO saem para o buscador (pedem para reescrever); palavra proibida também', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  const samples = [
    'pesquise o email joao@exemplo.com do meu amigo',
    'pesquise o cpf 123.456.789-09 dessa pessoa',
    'pesquise o telefone (21) 98877-6655 dessa loja',
    'pesquise esse token sk-abcdefghijklmnopqrstuvwxyz123456',
    'pesquise sobre tortura medieval hoje',
  ];
  for (const text of samples) {
    const r = await appSay({ text, fresh: true, script: () => 'nem deveria chegar ao modelo' });
    assert.equal(searches(), 0, text);
    assert.match(r.reply, /dado pessoal ou segredo|Não consigo pesquisar isso/, r.reply);
  }
}));
await test('app: o histórico e a memória NÃO vazam para a consulta nem para a síntese; o histórico em RAM guarda só a linha neutra do resultado (nunca o texto derivado da web)', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  const a = await startApp();
  const seenModel = [];
  const talk = async (text, script) => {
    resetRun();
    installModel((n, body) => { seenModel.push(body); return script(n, body); });
    const r = await a.call('POST', '/v1/chat', { token: OWNER_TOKEN, body: { message: text } });
    assert.equal(r.status, 200, r.raw);
    return r.json.reply;
  };
  await talk('meu nome é Zeferino e eu moro em Niterói', () => 'Prazer, Zeferino!');
  seenModel.length = 0;
  const reply = await talk(PS5_ASK, (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'não deveria chegar'));
  assert.ok(isResearchAnswer(reply), reply);
  assert.ok(!/zeferino|niter/i.test(queryOf(0)), `a consulta levou dado do histórico: ${queryOf(0)}`);
  assert.ok(seenModel.every((b) => !/zeferino|niter/i.test(JSON.stringify(b))), 'a síntese não viu o histórico nem a memória');
  seenModel.length = 0;
  await talk('e aí, entendeu?', () => 'Entendi sim.');
  const hist = JSON.stringify(seenModel[0].messages);
  assert.ok(hist.includes(NEUTRAL_LINE), 'a próxima conversa vê a linha neutra');
  assert.ok(!/R\$ 900|exemplo\.test|Fontes/.test(hist), `o resultado privado ficou no histórico em RAM: ${hist.slice(0, 400)}`);
  resetCooldowns();
}));
await test('app: a auditoria registra que houve pesquisa (tipo), sem o texto; o log do agente não leva a consulta', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  const r = await appSay({ text: 'pesquise sobre o lançamento do Hytale', route: 'chat', fresh: true, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
  assert.ok(isResearchAnswer(r.reply));
  const lines = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = [...lines].reverse().find((l) => l.event === 'api.chat' && l.research);
  assert.ok(last, 'linha api.chat com research');
  assert.equal(last.research, 'answer');
  assert.ok(!JSON.stringify(last).toLowerCase().includes('hytale'));
  assert.ok(!logLines.some((l) => /hytale/i.test(l)));
  resetCooldowns();
}));
await test('app com AI_PRIVATE_LOCAL_ONLY=true e memória pessoal em jogo: a pesquisa privada fica fechada (o texto sairia para a nuvem)', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true', AI_PRIVATE_LOCAL_ONLY: 'true' }, async () => {
  const owner = await appSay({ text: PS5_ASK, token: OWNER_TOKEN, fresh: true, script: () => 'nem deveria chegar ao modelo' });
  assert.equal(owner.reply, 'Não pesquiso na web numa conversa privada.');
  assert.equal(searches(), 0);
}));
await test('app com a chave mestra desligada (YUI_RESEARCH_ENABLED=false): não pesquisa nem com a pré-rota; a guarda final continua trocando a promessa', () => withEnv({ YUI_RESEARCH_ENABLED: 'false', YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  const a = await appSay({ text: PS5_ASK, fresh: true, script: () => 'O PS5 custa uns R$ 3.800.' });
  assert.match(a.reply, /R\$ 3\.800/);
  assert.equal(searches(), 0);
  const b = await appSay({ text: SEARCH_ASK, fresh: true, script: () => 'Vou pesquisar isso!' });
  assert.equal(b.reply, manager.APP_NO_SEARCH_REPLY, 'promessa de pesquisa sem pesquisa possível: diz a verdade');
  assert.equal(searches(), 0);
}));
await test('app: YUI_RESEARCH_GUARD=observe não muda a resposta (só metadados no log); off não loga nada', async () => {
  await withEnv({ YUI_RESEARCH_GUARD: 'observe', YUI_PRIVATE_SEARCH: 'all' }, async () => {
    const r = await appSay({ text: SEARCH_ASK, fresh: true, script: () => 'Vou pesquisar isso!' });
    assert.equal(r.reply, 'Vou pesquisar isso!');
    assert.equal(searches(), 0);
    assert.ok(logged(/guarda \(observe\): acao=search/));
    assert.ok(!logLines.some((l) => /hytale/i.test(l)));
  });
  await withEnv({ YUI_RESEARCH_GUARD: 'off', YUI_PRIVATE_SEARCH: 'all' }, async () => {
    const r = await appSay({ text: SEARCH_ASK, fresh: true, script: () => 'Vou pesquisar isso!' });
    assert.equal(r.reply, 'Vou pesquisar isso!');
    assert.ok(!logged(/\[Pesquisa\] guarda/));
  });
});
await test('app: sem resultado no buscador => mensagem com o motivo; buscador fora do ar => idem; nunca a promessa', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  for (const search of ['empty', 'down', 'rate']) {
    resetCooldowns();
    const r = await appSay({ text: SEARCH_ASK, fresh: true, search, script: () => 'nunca deveria chegar ao modelo' });
    assert.ok(r.reply.length > 20 && noPromise(r.reply), `${search}: ${r.reply}`);
    assert.ok(!isResearchAnswer(r.reply));
  }
  resetCooldowns();
}));
await test('app: o limite de 5 pesquisas por hora do usuário vale também aqui (o dono conta), com o motivo na resposta; YUI_SEARCH_USER_PER_HOUR=0 libera', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  const budget = getDefaultBudget();
  for (let i = 0; i < 5; i++) budget.takeUser(OWNER);
  const blocked = await appSay({ text: SEARCH_ASK, fresh: true, script: () => 'x' });
  assert.equal(searches(), 0);
  assert.match(blocked.reply, /limite|esperar|hora/i);
  await withEnv({ YUI_SEARCH_USER_PER_HOUR: '0' }, async () => {
    const free = await appSay({ text: SEARCH_ASK, fresh: true, script: (n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x') });
    assert.ok(isResearchAnswer(free.reply), free.reply);
  });
  getDefaultBudget().reset();
  resetCooldowns();
}));
await test('app: duas pesquisas do MESMO usuário ao mesmo tempo => a 2ª recebe o aviso de que já há uma em andamento (uma por pessoa), sem buscar de novo', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  getDefaultBudget().reset();
  resetRun();
  installModel((n, body) => (isSynthBody(body) ? SYNTH_ANSWER : 'x'));
  let open;
  const hold = new Promise((r) => { open = r; });
  searchHook = async (u) => { await hold; const q = new URL(u).searchParams.get('q') ?? ''; return jsonResp({ results: searxResults(q) }); };
  const a = await startApp();
  const p1 = a.call('POST', '/v1/chat', { token: OWNER_TOKEN, body: { message: SEARCH_ASK } });
  try {
    for (let i = 0; i < 100 && searches() < 1; i++) await sleep(20);
    const second = await a.call('POST', '/v1/chat', { token: OWNER_TOKEN, body: { message: 'pesquise sobre outra coisa qualquer' } });
    assert.equal(second.status, 200);
    assert.ok(!isResearchAnswer(second.json.reply), second.json.reply);
    assert.match(second.json.reply, /pesquisando o seu pedido anterior/i);
    assert.equal(searches(), 1);
  } finally {
    open(); // mesmo se uma asserção falhar, a pesquisa presa termina e devolve a vaga
  }
  const first = await p1;
  assert.ok(isResearchAnswer(first.json.reply), first.json.reply);
  getDefaultBudget().reset();
  resetCooldowns();
}));
await test('o app respeita o teto de pesquisas simultâneas fora da fila (compartilhado com o /yui): vagas ocupadas => aviso de ocupado e SEM buscar', () => withEnv({ YUI_PRIVATE_SEARCH: 'all', YUI_RESEARCH_PRE_ROUTE: 'true' }, async () => {
  resetCooldowns();
  const releases = [manager.researchSlots.tryAcquire(), manager.researchSlots.tryAcquire()];
  assert.ok(releases.every((r) => typeof r === 'function'));
  try {
    const r = await appSay({ text: SEARCH_ASK, fresh: true, script: () => 'x' });
    assert.equal(r.reply, manager.RESEARCH_BUSY_REPLY);
    assert.equal(searches(), 0);
  } finally {
    releases.forEach((f) => f());
  }
  assert.equal(manager.researchSlots.size(), 0);
}));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('D. O orquestrador (core/ai/manager.js) com dublês injetados: portas A, C e D, sem llmHandler');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const cfgOf = (over = {}) => () => ({ enabled: true, guard: 'on', preRoute: true, privateSearch: 'off', totalDeadlineMs: 60000, ...over });
function stubDeps(over = {}, llmOver = {}) {
  const researchCalls = [];
  const deps = {
    researchCalls,
    config: cfgOf(over.cfg),
    llm: {
      runResearchFor: async (a) => { researchCalls.push(a); return { text: 'RESPOSTA PESQUISADA', kind: 'answer', private: a.sensitive === true, historyLine: 'linha curta', ...llmOver.result }; },
      isToolDisabled: () => false,
      ...llmOver.llm,
    },
    slots: over.slots,
    currencyAnswer: over.currencyAnswer,
  };
  return deps;
}
await test('createSlotLimiter: no máximo N vagas, cada liberação devolve só a sua e vaga esquecida expira', () => {
  let t = 1000;
  const l = manager.createSlotLimiter(2, { ttlMs: 60_000, now: () => t });
  const a = l.tryAcquire();
  const b = l.tryAcquire();
  assert.ok(a && b);
  assert.equal(l.tryAcquire(), null);
  a(); a(); // liberar duas vezes não libera a vaga de outro
  assert.equal(l.size(), 1);
  const c = l.tryAcquire();
  assert.ok(c);
  assert.equal(l.tryAcquire(), null);
  t += 61_000; // as vagas esquecidas expiram
  assert.ok(l.tryAcquire());
  assert.equal(manager.OUTSIDE_QUEUE_MAX, 2);
});
await test('Porta A (routeExplicitResearch): chave mestra, pré-rota e pedido explícito decidem; o agente recebe SÓ a fala literal', async () => {
  const off = stubDeps({ cfg: { enabled: false } });
  assert.equal((await manager.routeExplicitResearch({ text: PS5_ASK }, off)).handled, false);
  const noRoute = stubDeps({ cfg: { preRoute: false } });
  assert.equal((await manager.routeExplicitResearch({ text: PS5_ASK }, noRoute)).reason, 'pré-rota desligada');
  const d = stubDeps();
  for (const text of ['oi yui, tudo bem?', 'não pesquise nada, só me diz oi', 'como eu pesquiso no google?', 'pesquise aí a música Welcome to the Jungle', '']) {
    const r = await manager.routeExplicitResearch({ text, userId: 'u1' }, d);
    assert.equal(r.handled, false, text);
  }
  assert.equal(d.researchCalls.length, 0);
  const ok = await manager.routeExplicitResearch({ text: PS5_ASK, userId: 'u1', guildId: 'g9', channelId: 'c9', isOwner: false }, d);
  assert.equal(ok.handled, true);
  assert.equal(ok.text, 'RESPOSTA PESQUISADA');
  assert.equal(ok.researched, true);
  assert.equal(d.researchCalls.length, 1);
  const call = d.researchCalls[0];
  assert.equal(call.question, PS5_ASK, 'a pergunta é a fala literal');
  assert.match(call.query, /ps5/i);
  assert.deepEqual([call.userId, call.sensitive, call.guildId, call.channelId], ['u1', false, 'g9', 'c9']);
});
await test('Porta A em conversa privada: off recusa; owner só o dono; all todos; privateBlocked fecha; a recusa vem ANTES de chamar o agente', async () => {
  const run = (privateSearch, isOwner, extra = {}) => { const d = stubDeps({ cfg: { privateSearch } }); return manager.routeExplicitResearch({ text: PS5_ASK, sensitive: true, isOwner, userId: 'u1', ...extra }, d).then((r) => ({ r, d })); };
  for (const [mode, isOwner, expectSearch] of [['off', true, false], ['owner', true, true], ['owner', false, false], ['all', false, true], ['all', true, true]]) {
    const { r, d } = await run(mode, isOwner);
    assert.equal(d.researchCalls.length, expectSearch ? 1 : 0, `${mode}/${isOwner}`);
    assert.equal(r.handled, true);
    if (!expectSearch) assert.equal(r.text, 'Não pesquiso na web numa conversa privada.');
    else assert.equal(d.researchCalls[0].sensitive, true);
  }
  const blocked = await run('all', true, { privateBlocked: true });
  assert.equal(blocked.d.researchCalls.length, 0);
  assert.equal(blocked.r.text, 'Não pesquiso na web numa conversa privada.');
});
await test('ferramenta local do app (skipCodeSearch): a Porta A não roteia e a Porta C troca "pesquisar" por pedir a resposta final; a detecção é estreita e não trava com texto hostil', async () => {
  const d = stubDeps({ cfg: { privateSearch: 'all' } });
  const owner = { role: 'OWNER', userId: OWNER, memoryScope: 'personal' };
  for (const text of ['pesquise o arquivo relatorio.docx', 'pesquisa nos meus arquivos o contrato', 'procure a pasta de backup', 'busque no meu computador o projeto yui']) {
    assert.equal((await manager.appResearchRoute({ ctx: owner, text }, d)).handled, false, text);
  }
  assert.equal(d.researchCalls.length, 0);
  for (const text of ['pesquise o preço da ram ddr5 hoje', 'pesquise apps de edição de vídeo grátis', 'pesquise o melhor sistema operacional para jogos']) {
    assert.equal((await manager.appResearchRoute({ ctx: owner, text }, d)).researched, true, text);
  }
  const regen = [];
  const r = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: 'pesquise o arquivo relatorio.docx', sensitive: true, skipCodeSearch: true, regenerate: async (p) => { regen.push(p); return 'Não acho daqui.'; } }, stubDeps({ cfg: { privateSearch: 'all' } }));
  assert.deepEqual([r.text, r.action, regen.length], ['Não acho daqui.', 'regenerate', 1]);
  const t0 = performance.now();
  for (const hostile of ['meu '.repeat(175), `minha ${'a '.repeat(340)}`, `pesquise ${'o '.repeat(340)}`, 'procur'.repeat(116)]) await manager.appResearchRoute({ ctx: owner, text: hostile }, d);
  assert.ok(performance.now() - t0 < 500, `levou ${Math.round(performance.now() - t0)} ms`);
});
await test('Porta A: ferramenta desligada no servidor, vagas esgotadas e agente que lança — nada lança e a resposta é honesta', async () => {
  const disabled = stubDeps({}, { llm: { isToolDisabled: () => true } });
  assert.equal((await manager.routeExplicitResearch({ text: PS5_ASK }, disabled)).text, 'A pesquisa na web está desativada neste servidor.');
  assert.equal(disabled.researchCalls.length, 0);
  const full = stubDeps({ slots: manager.createSlotLimiter(0) });
  const busy = await manager.routeExplicitResearch({ text: PS5_ASK }, full);
  assert.equal(busy.text, manager.RESEARCH_BUSY_REPLY);
  assert.equal(full.researchCalls.length, 0);
  const boom = stubDeps({}, { llm: { runResearchFor: async () => { throw new Error('explodiu'); } } });
  const r = await manager.routeExplicitResearch({ text: PS5_ASK }, boom);
  assert.equal(r.handled, false, 'o erro do agente cai no fluxo normal (o modelo responde)');
  assert.equal(manager.researchSlots.size(), 0);
});
await test('Porta A libera a vaga mesmo quando o agente lança (não vaza vaga)', async () => {
  const slots = manager.createSlotLimiter(1);
  const boom = stubDeps({ slots }, { llm: { runResearchFor: async () => { throw new Error('explodiu'); } } });
  await manager.routeExplicitResearch({ text: PS5_ASK }, boom);
  assert.equal(slots.size(), 0);
  const ok = stubDeps({ slots });
  assert.equal((await manager.routeExplicitResearch({ text: PS5_ASK }, ok)).handled, true);
});
await test('Portas C e D (reviewResearchReply): sem promessa a resposta fica como está e nada é chamado', async () => {
  const d = stubDeps();
  const r = await manager.reviewResearchReply({ reply: 'O PS5 custa uns R$ 3.800.', text: 'quanto custa o ps5?', regenerate: async () => 'x' }, d);
  assert.deepEqual([r.text, r.researched, r.guarded, r.action], ['O PS5 custa uns R$ 3.800.', false, false, 'none']);
  assert.equal(d.researchCalls.length, 0);
  assert.equal((await manager.reviewResearchReply({ reply: '', text: 'oi' }, d)).text, '');
  assert.equal((await manager.reviewResearchReply({ reply: '   ', text: 'oi' }, d)).text, '   ');
});
await test('Porta C: promessa + pedido de pesquisa => pesquisa (consulta do pedido); promessa sem pedido mas com assunto => consulta da promessa; lista grande => resposta final', async () => {
  const d = stubDeps();
  const a = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK, userId: 'u1' }, d);
  assert.deepEqual([a.text, a.researched, a.historyLine, a.kind], ['RESPOSTA PESQUISADA', true, 'linha curta', 'answer']);
  assert.match(d.researchCalls[0].query, /hytale/i);
  const d2 = stubDeps();
  const b = await manager.reviewResearchReply({ reply: 'Vou buscar dados de preços de financiamento e manutenção no Rio de Janeiro pra te dar opções precisas.', text: 'yui rio de janeiro, parcelas de ate 900 e o uso rotineiro / trabalho', userId: 'u1' }, d2);
  assert.equal(b.researched, true);
  assert.match(d2.researchCalls[0].query, /financiamento/i);
  assert.match(d2.researchCalls[0].intent, /Vou buscar dados/);
  const list = Array.from({ length: 45 }, (_, i) => `- mod ${i + 1}`).join('\n');
  const prompts = [];
  const d3 = stubDeps();
  const c = await manager.reviewResearchReply({ reply: 'Vou pesquisar os links de cada mod!', text: `pega o link de cada um:\n${list}`, regenerate: async (p) => { prompts.push(p); return 'Me manda 3 por vez.'; } }, d3);
  assert.deepEqual([c.text, c.researched, c.action], ['Me manda 3 por vez.', false, 'regenerate']);
  assert.equal(d3.researchCalls.length, 0);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('Responda AGORA'));
});
await test('Porta C: a nova resposta vazia ou em JSON de ferramenta é descartada; a promessa que sobra é trocada pelo aviso (Porta D)', async () => {
  for (const again of ['', '   ', '{"tool":"download_audio","args":{}}', '[1,2]', undefined]) {
    const r = await manager.reviewResearchReply({ reply: 'Um segundo, já te respondo', text: 'me explica como funciona o rollback netcode?', regenerate: async () => again }, stubDeps());
    assert.equal(r.guarded, true, String(again));
    assert.match(r.text, /Desculpe, tive um erro ao fechar essa resposta/);
  }
  const noRegen = await manager.reviewResearchReply({ reply: 'Um segundo, já te respondo', text: 'me explica como funciona o rollback netcode?' }, stubDeps());
  assert.equal(noRegen.guarded, true);
});
await test('Porta C: ação/busca já feita (hadAction, usedSearch) não pesquisa de novo; usedSearch ainda deixa a guarda final trocar uma promessa', async () => {
  const d = stubDeps();
  const a = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK, hadAction: true }, d);
  assert.deepEqual([a.text, a.guarded], ['Vou pesquisar isso!', false], 'houve ação: nada a trocar');
  assert.equal(d.researchCalls.length, 0);
  const b = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK, usedSearch: true }, d);
  assert.equal(d.researchCalls.length, 0, 'a busca automática já rodou: não gasta outra');
  assert.equal(b.guarded, true);
  assert.match(b.text, /Desculpe, tive um erro/);
});
await test('Porta C no privado: off recusa; liberado só pesquisa pedido explícito (consulta do texto literal, nunca da promessa); não explícito pede a resposta final', async () => {
  const off = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: PS5_ASK, sensitive: true }, stubDeps());
  assert.equal(off.text, 'Não pesquiso na web numa conversa privada.');
  const all = stubDeps({ cfg: { privateSearch: 'all' } });
  const a = await manager.reviewResearchReply({ reply: 'Vou pesquisar o preço do ps5 para Zeferino em Niterói!', text: PS5_ASK, sensitive: true, userId: 'u1' }, all);
  assert.equal(a.researched, true);
  assert.equal(all.researchCalls.length, 1);
  assert.ok(!/zeferino|niter/i.test(all.researchCalls[0].query), all.researchCalls[0].query);
  assert.equal(all.researchCalls[0].sensitive, true);
  assert.ok(!all.researchCalls[0].intent, 'a promessa do modelo não vai ao agente no privado');
  const regen = [];
  const b = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: 'me fala do preço do ps5 hoje', sensitive: true, regenerate: async (p) => { regen.push(p); return 'Não sei dizer.'; } }, stubDeps({ cfg: { privateSearch: 'all' } }));
  assert.deepEqual([b.text, b.action, regen.length], ['Não sei dizer.', 'regenerate', 1]);
});
await test('searchIfExplicit: sem ferramentas, o pedido explícito respondido "de cabeça" também é pesquisado (público ou privado liberado); sem a opção, não', async () => {
  const mk = (extra, cfg) => manager.reviewResearchReply({ reply: 'O PS5 custa uns R$ 3.800.', text: PS5_ASK, userId: 'u1', ...extra }, stubDeps({ cfg }));
  const yes = await mk({ searchIfExplicit: true });
  assert.deepEqual([yes.researched, yes.text], [true, 'RESPOSTA PESQUISADA']);
  assert.equal((await mk({})).researched, false);
  assert.equal((await mk({ searchIfExplicit: true }, { enabled: false })).researched, false, 'chave mestra');
  assert.equal((await mk({ searchIfExplicit: true }, { guard: 'off' })).researched, false, 'guarda desligada');
  assert.equal((await mk({ searchIfExplicit: true, sensitive: true })).researched, false, 'privado desligado: o chute do modelo fica (e nada é pesquisado)');
  assert.equal((await mk({ searchIfExplicit: true, sensitive: true }, { privateSearch: 'all' })).researched, true);
  assert.equal((await manager.reviewResearchReply({ reply: 'Boa pergunta, não sei.', text: 'oi yui, tudo bem?', searchIfExplicit: true }, stubDeps())).researched, false, 'conversa comum nunca');
});
await test('Porta C: ferramenta desligada no servidor, cotação e agente que lança — respostas honestas e nada lança', async () => {
  const off = stubDeps({}, { llm: { isToolDisabled: () => true } });
  const a = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK }, off);
  assert.equal(a.text, 'A pesquisa na web está desativada neste servidor.');
  assert.equal(a.guarded, false);
  const money = stubDeps({ currencyAnswer: async (args) => `1 ${args.from} = 5,50 ${args.to}` });
  const b = await manager.reviewResearchReply({ reply: 'Vou ver a cotação do dólar pra você!', text: 'quanto está o dólar hoje em reais?' }, money);
  assert.match(b.text, /^1 USD = 5,50 BRL$/);
  assert.equal(money.researchCalls.length, 0, 'cotação não passa pelo buscador');
  const boom = stubDeps({}, { llm: { runResearchFor: async () => { throw new Error('explodiu'); } } });
  const c = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK }, boom);
  assert.equal(c.guarded, true, 'o erro do agente cai na guarda final: a promessa não chega à pessoa');
  assert.match(c.text, /Desculpe, tive um erro/);
  assert.equal(manager.researchSlots.size(), 0);
});
await test('modos da guarda: observe só loga metadados e não troca nada; off desliga as Portas C e D; chave mestra desligada mantém só a Porta D', async () => {
  logLines.length = 0;
  const obs = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK }, stubDeps({ cfg: { guard: 'observe' } }));
  assert.deepEqual([obs.text, obs.guarded, obs.researched], ['Vou pesquisar isso!', false, false]);
  assert.ok(logged(/guarda \(observe\): acao=search/) && logged(/guarda final \(observe\)/));
  assert.ok(!logLines.some((l) => /hytale/i.test(l)));
  const off = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK }, stubDeps({ cfg: { guard: 'off' } }));
  assert.equal(off.text, 'Vou pesquisar isso!');
  const master = stubDeps({ cfg: { enabled: false } });
  const m = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!', text: SEARCH_ASK }, master);
  assert.equal(master.researchCalls.length, 0);
  assert.equal(m.guarded, true);
});
await test('a guarda final do APP (appMode) diz a verdade quando a promessa era de pesquisa: "não consegui pesquisar"; sem pedido de pesquisa vale o aviso de sempre; as frases fixas NÃO são promessa', async () => {
  const a = await manager.reviewResearchReply({ reply: 'Vou pesquisar isso!\n-# Modelo: x', text: 'quero saber o lançamento do Hytale', appMode: true, sensitive: true, regenerate: async () => 'Vou pesquisar isso!\n-# Modelo: x' }, stubDeps({ cfg: { privateSearch: 'all' } }));
  assert.equal(a.text, `${manager.APP_NO_SEARCH_REPLY}\n-# Modelo: x`, 'mantém o rodapé');
  const b = await manager.reviewResearchReply({ reply: 'Um segundo, já te respondo', text: 'me explica como funciona o rollback netcode?', appMode: true }, stubDeps());
  assert.match(b.text, /Desculpe, tive um erro ao fechar essa resposta/);
  for (const fixed of [manager.APP_NO_SEARCH_REPLY, manager.RESEARCH_BUSY_REPLY]) {
    assert.equal(intent.detectUnfulfilledPromise(fixed).promise, false, fixed);
    assert.equal(intent.finalGuard(fixed, { hadAction: false, userNeedsAnswer: true }), fixed, fixed);
  }
});
await test('o app (appResearchRoute / appReviewReply): sempre privado, dono pelo papel, chamada direta; o dono em memória pessoal sai de AI_PRIVATE_LOCAL_ONLY', async () => {
  const d = stubDeps({ cfg: { privateSearch: 'owner' } });
  const owner = { role: 'OWNER', userId: OWNER, memoryScope: 'personal' };
  const member = { role: 'MEMBER', userId: '222', memoryScope: 'public' };
  const a = await manager.appResearchRoute({ ctx: owner, text: PS5_ASK }, d);
  assert.equal(a.researched, true);
  assert.deepEqual([d.researchCalls[0].sensitive, d.researchCalls[0].isOwner, d.researchCalls[0].userId, d.researchCalls[0].guildId], [true, true, OWNER, null]);
  const b = await manager.appResearchRoute({ ctx: member, text: PS5_ASK }, d);
  assert.equal(b.text, 'Não pesquiso na web numa conversa privada.');
  assert.equal(d.researchCalls.length, 1);
  await withEnv({ AI_PRIVATE_LOCAL_ONLY: 'true' }, async () => {
    const c = await manager.appResearchRoute({ ctx: owner, text: PS5_ASK }, d);
    assert.equal(c.text, 'Não pesquiso na web numa conversa privada.');
    const e = await manager.appResearchRoute({ ctx: { ...member, memoryScope: 'public' }, text: PS5_ASK }, stubDeps({ cfg: { privateSearch: 'all' } }));
    assert.equal(e.researched, true, 'sem memória pessoal em jogo, a regra não se aplica');
  });
});
await test('chat() aceita deadlineAt e o repassa SÓ quando existe (o formato dos backends existentes não muda)', async () => {
  const seen = [];
  manager.registerBackend({ name: 'espiao', local: true, async chat(args) { seen.push(args); return 'ok'; } }, { activate: true });
  try {
    await manager.chat({ prompt: 'oi', ctx: { role: 'OWNER', memoryScope: 'public' } });
    await manager.chat({ prompt: 'oi', ctx: { role: 'OWNER', memoryScope: 'public' }, deadlineAt: 123456 });
    assert.equal('deadlineAt' in seen[0], false);
    assert.equal(seen[1].deadlineAt, 123456);
    const turn = await manager.chatTurn({ prompt: 'oi yui', ctx: { role: 'OWNER', userId: OWNER, memoryScope: 'public' } }, stubDeps());
    assert.deepEqual([turn.text, turn.researched, turn.guarded], ['ok', false, false]);
  } finally {
    manager.initAiManager();
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('E. Requisitos nas fontes');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('ask.js: usa o agente (rota A, revisão C e D), a síntese não leva `ctx`, e a entrega PARCIAL não vira erro', () => {
  const src = readSrc('src/discord/commands/ask.js');
  assert.ok(src.includes('routeExplicitResearch(') && src.includes('reviewResearchReply('));
  assert.ok(/if \(!delivery\.ok && !delivery\.partial\) throw/.test(src));
  assert.ok(/!researchHandled/.test(src), 'a troca de uma pesquisa não vai ao contexto por horas');
  assert.ok(/searchPrompt:\s*pergunta/.test(src) && /text:\s*pergunta/.test(src), 'a fala do autor é a pergunta, nunca o prompt com o `ctx`');
  assert.ok(!/console\.(log|warn|error)/.test(src));
  assert.ok(/progress\.settle\(\)/.test(src), 'nenhuma edição de progresso sobrescreve a resposta final');
});
await test('manager.js e server.js: sem console.*, sem texto de usuário no log, e o app usa chatTurn / appResearchRoute / appReviewReply', () => {
  const mgr = readSrc('src/core/ai/manager.js');
  const srv = readSrc('src/core/api/server.js');
  assert.ok(!/console\.(log|warn|error)/.test(mgr) && !/console\.(log|warn|error)/.test(srv));
  assert.ok(srv.includes('ai.chatTurn(') && srv.includes('ai.appResearchRoute(') && srv.includes('ai.appReviewReply('));
  for (const m of mgr.matchAll(/logger\.(?:info|warn|error)\(([^\n]*)\)/g)) {
    assert.ok(!/\b(?:text|prompt|message|reply|query)\b(?!Tag)/.test(m[1].replace(/\$\{[^}]*errorTag[^}]*\}/g, '')), `log com texto de usuário: ${m[0]}`);
  }
  assert.ok(!/^import .*llmHandler/m.test(mgr), 'o Core não importa o llmHandler (Discord) na carga: só sob demanda');
});
await test('o texto de nenhum arquivo do pacote mudou de fim de linha: ask.js, manager.js e server.js continuam LF puro', () => {
  for (const rel of ['src/discord/commands/ask.js', 'src/core/ai/manager.js', 'src/core/api/server.js']) {
    const b = fs.readFileSync(path.join(repoRoot, rel));
    assert.ok(!b.includes(13), `${rel} tem CR`);
  }
});
await test('exports usados pelos outros pacotes continuam: runResearchFor, isToolDisabled, stripThinking, isSystemReply (llmHandler)', () => {
  for (const name of ['runResearchFor', 'isToolDisabled', 'stripThinking', 'isSystemReply', 'generateResponse']) assert.equal(typeof llmNames[name], 'function', name);
});

// ── Resultado ───────────────────────────────────────────────────────────────────────────────────
for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* já fechado */ } }
say(`\n${failures.length === 0 ? 'Tudo certo' : 'COM FALHAS'}: ${passed} teste(s) ok${failures.length ? `, ${failures.length} falhou(aram): ${failures.join(' | ')}` : ''}`);
process.chdir(repoRoot);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* pode estar em uso (logs) */ }
process.exit(failures.length ? 1 : 0);
