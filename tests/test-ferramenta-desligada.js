// Ferramenta DESLIGADA no servidor vale em TODOS os caminhos (item 1 do plano das lacunas do painel, docs/PLANO_LACUNAS_PAINEL.md, 26/11/2026).
// Antes o painel dizia "desligada" e a função continuava: o /yui-imagem e a pré-rota de GTA (Porta G) não conferiam o interruptor, nem os outros
// comandos de barra, o "+yui musica", a Porta T dos lembretes (na conversa e no /yui) e o atalho da música do status.
//  A. o módulo puro src/handlers/ferramentaDesligada.js: a frase (a mesma do despachante), só em servidor, comando -> ferramenta e lembretes;
//  B. a FILA de verdade do llmHandler: Porta G, Porta T e o atalho da música do status recusam num servidor com a ferramenta desligada,
//     funcionam num servidor com ela ligada e, na DM, nada muda;
//  C. o /yui (ask.js) e o "+yui musica" (prefixRouter.js): os dois lados;
//  D. as fontes: cada caminho passa pelo módulo (nenhuma frase copiada à mão).
// Os comandos de barra (/yui-imagem e os outros) e a escolha da faixa do Deezer estão no tests/test-interaction-limits.js (seção 8).
// SEM rede, SEM Discord real e SEM os arquivos reais: server_tools.json, lembretes e bancos numa pasta temporária; axios, fetch, DNS e sockets falham.
// Execução: npm run test:ferramentadesligada   (node tests/test-ferramenta-desligada.js)
// Mutação: YUI_TEST_LLM_FILE=src/handlers/<cópia alterada>.js YUI_TEST_ONLY=<regex> node tests/test-ferramenta-desligada.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLM_REL = process.env.YUI_TEST_LLM_FILE || 'src/handlers/llmHandler.js';

// ── Ambiente isolado ────────────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ferramenta-desligada-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const MEMBER2 = '333333333333333333';
const G_OFF = '700000000000000001'; // servidor com as ferramentas desligadas no painel
const G_ON = '700000000000000002'; // servidor com tudo no padrão (ligado)
const SERVER_TOOLS = path.join(tmp, 'server_tools.json');
// O interruptor do servidor, gravado ANTES de importar o llmHandler (ele lê o arquivo ao subir): o mesmo formato que o painel grava.
fs.writeFileSync(SERVER_TOOLS, JSON.stringify({
  [G_OFF]: { enabled: [], disabled: ['gta_online', 'criar_lembrete', 'listar_lembretes', 'get_current_music', 'search_and_download_music', 'download_audio', 'generate_image'] },
}, null, 2));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  YUI_OWNER_ID: OWNER,
  YUI_SERVER_TOOLS_FILE: SERVER_TOOLS,
  YUI_MEMORY_ENABLED: 'false',
  YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  YUI_SEARCH_PROVIDERS: 'searxng',
  SEARXNG_URL: 'http://searx.invalid/',
  REDDIT_FETCH_MODE: 'off', // nunca abre navegador
  YUI_POLICY_MODE: 'observe',
  YUI_QUEUE_MAX_PER_USER: '20',
  LOG_LEVEL: 'error',
});
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'YUI_REPLY_MAX_TOKENS', 'YUI_CONTEXT_ENABLED',
  'YUI_CONTEXT_SCOPE', 'YUI_VOICE_TOOLS', 'YUI_CEREBRO_EXTERNO', 'YUI_REMINDERS_ENABLED', 'YUI_REMINDERS_ALL_USERS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS',
  'YUI_READ_ONLY', 'YUI_PLANOS', 'YUI_YOUTUBE_LIVE', 'YUI_GOOGLE', 'YUI_CONTINUIDADE', 'YUI_MODLIST_ENABLED', 'YUI_IMAGE_PRE_ROUTE', 'YUI_BDS_URL']) delete process.env[k];
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

// Nada sai da máquina.
const { default: axios } = await import('axios');
let postHook = null;
axios.post = async (url, body, config) => {
  const fake = postHook ? await postHook(String(url), body, config) : undefined;
  if (fake !== undefined) return fake;
  throw new Error('offline (teste)');
};
axios.get = async () => { throw new Error('offline (teste)'); };
axios.request = async () => { throw new Error('offline (teste)'); };
globalThis.fetch = async (url) => { throw new Error(`fetch bloqueado no teste: ${String(url).slice(0, 40)}`); };
net.Socket.prototype.connect = function blocked() { throw new Error('rede bloqueada no teste'); };
dns.promises.lookup = async () => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; throw e; };
dns.lookup = (host, opts, cb) => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e); };
// Escritas nos arquivos REAIS de dados do projeto são desviadas (o histórico em disco também).
const realWriteFileSync = fs.writeFileSync;
const realAppendFile = fs.appendFile;
fs.writeFileSync = function guardedWrite(file, ...rest) {
  const f = String(file);
  if (/[\\/]src[\\/]data[\\/][^\\/]+\.json$/.test(f) && !f.startsWith(tmp)) return undefined;
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
    passed += 1;
    say(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 30_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !pred()) await sleep(20); return pred(); };
const readSrc = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ── Módulos sob teste ───────────────────────────────────────────────────────────────────────────
const fd = await import(pathToFileURL(path.join(repoRoot, 'src/handlers/ferramentaDesligada.js')).href);
const { parseReminderRequest } = await import(pathToFileURL(path.join(repoRoot, 'src/reminders/assistant.js')).href);
const { default: config } = await import(pathToFileURL(path.join(repoRoot, 'src/config/index.js')).href);
config.saveHistory = false;
const { default: legacyConfig } = await import(pathToFileURL(path.join(repoRoot, 'src/config.js')).href);
legacyConfig.saveHistory = false;
const { logger } = await import(pathToFileURL(path.join(repoRoot, 'src/utils/logger.js')).href);
const logLines = [];
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (...args) => { logLines.push(`${level}: ${args.map(String).join(' ')}`); };
const llm = await import(pathToFileURL(path.join(repoRoot, LLM_REL)).href);
console.log = console.warn = console.error = () => {}; // o llmHandler é falante; o resultado sai por say()

const TOOLS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/data/mcp_tools.json'), 'utf8'));
const TOOL = Object.fromEntries(TOOLS.map((t) => [t.function.name, t]));
const recusa = (tool) => `⚠️ A ferramenta \`${tool}\` está desativada neste servidor.`;

// ── IA local falsa (LM Studio): responde texto fixo; conta as chamadas ───────────────────────────
const URL_LOCAL = config.localLlmUrl;
let localCalls = 0;
function sse(text) {
  const lines = [];
  for (const ch of [text]) lines.push(`data: ${JSON.stringify({ model: 'modelo-falso', choices: [{ delta: { content: ch }, finish_reason: null }] })}`);
  lines.push(`data: ${JSON.stringify({ model: 'modelo-falso', choices: [{ delta: {}, finish_reason: 'stop' }] })}`);
  lines.push('data: [DONE]');
  return Readable.from([Buffer.from(`${lines.join('\n\n')}\n\n`, 'utf8')]);
}
postHook = (url) => {
  if (url !== URL_LOCAL) return undefined;
  localCalls += 1;
  return { data: sse('Resposta do modelo falso.') };
};

// ── Mensagem de menção falsa (como a do messageCreate) ───────────────────────────────────────────
let seq = 0;
function fakeMention({ userId = MEMBER, guildId = G_OFF, content }) {
  const outs = [];
  const channelId = `chan-${++seq}`;
  const replyMsg = { id: `proc-${seq}`, async edit(p) { outs.push(p); return replyMsg; }, async delete() { return undefined; } };
  const msg = {
    id: `msg-${seq}`, content: `<@999> ${content}`, channelId, guildId, guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    author: { id: userId, tag: `u${userId}#0001`, username: `u${seq}`, bot: false },
    client: { user: { id: '999' } },
    mentions: { has: () => true, everyone: false, repliedUser: null, users: new Map() },
    channel: { id: channelId, name: 'geral', type: guildId ? 0 : 1, send: async (p) => { outs.push(p); return { id: 'sent' }; }, sendTyping: async () => {} },
    async reply(p) { outs.push(p); return replyMsg; },
    outs,
  };
  return msg;
}
const textOf = (p) => (typeof p === 'string' ? p : typeof p?.content === 'string' ? p.content : '');
const isProgress = (t) => /Processando|Sua solicitação está na fila/.test(t); // o aviso de posição na fila não é a resposta
const finalTexts = (m) => m.outs.map(textOf).filter((t) => t && !isProgress(t));
const embedsOf = (m) => m.outs.flatMap((p) => (Array.isArray(p?.embeds) ? p.embeds : []));

/** Enfileira a fala (menção direta à Yui) e espera a primeira resposta final. */
async function mention(text, { userId = MEMBER, guildId = G_OFF, until = null } = {}) {
  localCalls = 0;
  const m = fakeMention({ userId, guildId, content: text });
  await llm.addToQueue(text, m, 'mention', { allowSearch: false, guildId: guildId ?? undefined, searchPrompt: text });
  const done = await waitFor(() => (until ? until(m) : finalTexts(m).length > 0 || embedsOf(m).length > 0));
  assert.ok(done, 'a fila não respondeu');
  await sleep(150); // o que vem depois da entrega (log, histórico) roda logo em seguida
  return m;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('A. O módulo puro (src/handlers/ferramentaDesligada.js)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('a frase é a do despachante, com o nome da ferramenta', () => {
  assert.equal(fd.textoFerramentaDesligada('generate_image'), recusa('generate_image'));
  assert.equal(fd.textoFerramentaDesligada('gta_online'), recusa('gta_online'));
});
await test('recusaSeDesligada: servidor com a ferramenta desligada recusa; ligada, DM, sem ferramenta ou isToolDisabled quebrado passam', () => {
  const desl = (g, t) => g === G_OFF && t === 'gta_online';
  assert.equal(fd.recusaSeDesligada(G_OFF, 'gta_online', desl), recusa('gta_online'));
  assert.equal(fd.recusaSeDesligada(G_ON, 'gta_online', desl), null, 'servidor com a ferramenta ligada');
  assert.equal(fd.recusaSeDesligada(G_OFF, 'search_game', desl), null, 'outra ferramenta, ligada');
  assert.equal(fd.recusaSeDesligada(null, 'gta_online', () => true), null, 'DM: nada muda, mesmo que o interruptor diga "desligada"');
  assert.equal(fd.recusaSeDesligada(undefined, 'gta_online', () => true), null);
  assert.equal(fd.recusaSeDesligada(G_OFF, null, () => true), null, 'comando sem ferramenta');
  assert.equal(fd.recusaSeDesligada(G_OFF, 'gta_online', () => { throw new Error('x'); }), null, 'falha ao ler: segue como antes');
  assert.equal(fd.recusaSeDesligada(G_OFF, 'gta_online', null), null);
  assert.equal(fd.recusaSeDesligada(G_OFF, 'gta_online', () => 'sim'), null, 'só true conta');
});
await test('ferramentaDoComando: cada comando de barra aponta para a ferramenta alternável certa; /baixar_musica olha busca ou link', () => {
  const opts = (s) => ({ getString: (n) => (n in s ? s[n] : null) });
  const esperado = {
    'yui-imagem': 'generate_image', baixar_video: 'download_video', buscar_jogo: 'search_game', steam_jogo: 'check_steam', converter_moeda: 'convert_currency', baixar_musica_atual: 'get_current_music',
    // 27/11/2026 (decisão do Braga): os comandos do GTA obedecem ao mesmo interruptor do GTA pela conversa.
    'gta-diario': 'gta_online', 'gta-semanal': 'gta_online', 'gta-noticias': 'gta_online',
  };
  for (const [cmd, tool] of Object.entries(esperado)) {
    assert.equal(fd.ferramentaDoComando(cmd, opts({})), tool, cmd);
    assert.ok(TOOL[tool] && TOOL[tool].meta.disableable === true, `${tool} existe no mcp_tools.json e pode ser desligada`);
  }
  assert.equal(fd.ferramentaDoComando('baixar_musica', opts({ busca: 'artista' })), 'search_and_download_music');
  assert.equal(fd.ferramentaDoComando('baixar_musica', opts({ url: 'https://exemplo.test/a' })), 'download_audio');
  assert.equal(fd.ferramentaDoComando('baixar_musica', opts({ busca: 'artista', url: 'https://exemplo.test/a' })), 'search_and_download_music', 'a busca vence, como no comando');
  assert.equal(fd.ferramentaDoComando('baixar_musica', opts({})), null, 'sem nada o próprio comando recusa');
  assert.equal(fd.ferramentaDoComando('baixar_musica', { getString: () => { throw new Error('x'); } }), null);
  for (const livre of ['yui', 'yui-status', 'yui-configurar', 'sair-call', 'entrar-call', 'modo-radio', 'ajuda', 'chat_resumo', 'anime_origem', 'toString', '__proto__', '', undefined]) {
    assert.equal(fd.ferramentaDoComando(livre, opts({})), null, String(livre));
  }
  for (const tool of ['search_and_download_music', 'download_audio']) assert.equal(TOOL[tool].meta.disableable, true, tool);
});
await test('recusaDeLembrete: "meus lembretes" é listar_lembretes; criar, adiar e cancelar são criar_lembrete; conversa comum e DM passam', () => {
  const so = (tool) => (g, t) => g === G_OFF && t === tool;
  const base = { guildId: G_OFF, interpretar: parseReminderRequest, env: {} };
  assert.equal(fd.recusaDeLembrete({ ...base, text: 'meus lembretes', isToolDisabled: so('listar_lembretes') }), recusa('listar_lembretes'));
  assert.equal(fd.recusaDeLembrete({ ...base, text: 'meus lembretes', isToolDisabled: so('criar_lembrete') }), null, 'só criar desligado: listar passa');
  assert.equal(fd.recusaDeLembrete({ ...base, text: 'resumo do dia', isToolDisabled: so('listar_lembretes') }), recusa('listar_lembretes'));
  for (const t of ['me lembra daqui 10 minutos de beber água', 'me lembra de pagar a conta', 'cancela o lembrete 3', 'adia o lembrete 2 por 30 minutos']) {
    assert.equal(fd.recusaDeLembrete({ ...base, text: t, isToolDisabled: so('criar_lembrete') }), recusa('criar_lembrete'), t);
    assert.equal(fd.recusaDeLembrete({ ...base, text: t, isToolDisabled: so('listar_lembretes') }), null, `${t} (só listar desligado)`);
  }
  for (const t of ['você lembra do Gabriel?', 'oi yui', '']) assert.equal(fd.recusaDeLembrete({ ...base, text: t, isToolDisabled: () => true }), null, t);
  assert.equal(fd.recusaDeLembrete({ ...base, guildId: null, text: 'meus lembretes', isToolDisabled: () => true }), null, 'DM: nada muda');
  assert.equal(fd.recusaDeLembrete({ ...base, env: { YUI_REMINDERS_ENABLED: 'false' }, text: 'meus lembretes', isToolDisabled: () => true }), null, 'lembretes desligados: segue como antes');
  assert.equal(fd.recusaDeLembrete({ ...base, interpretar: null, text: 'meus lembretes', isToolDisabled: () => true }), null);
  assert.equal(fd.recusaDeLembrete({ ...base, interpretar: () => { throw new Error('x'); }, text: 'meus lembretes', isToolDisabled: () => true }), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('B. A fila de verdade do llmHandler (menção direta à Yui)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('o interruptor do arquivo chegou ao llmHandler: desligadas em G_OFF, ligadas em G_ON e na DM', () => {
  for (const t of ['gta_online', 'criar_lembrete', 'listar_lembretes', 'get_current_music']) {
    assert.equal(llm.isToolDisabled(G_OFF, t), true, t);
    assert.equal(llm.isToolDisabled(G_ON, t), false, t);
    assert.equal(llm.isToolDisabled(null, t), false, `${t} na DM`);
  }
});
await test('Porta G: GTA pela conversa num servidor com gta_online desligada recebe a recusa, sem buscar nada nem chamar a IA', async () => {
  const m = await mention('o que tem no gta hoje?', { guildId: G_OFF });
  assert.deepEqual(finalTexts(m), [recusa('gta_online')]);
  assert.equal(embedsOf(m).length, 0);
  assert.equal(localCalls, 0, 'nem a IA nem a busca');
  assert.ok(logLines.some((l) => /Porta G recusada/.test(l)), 'o log diz que recusou (sem o texto da pessoa)');
  assert.ok(!logLines.some((l) => /o que tem no gta hoje/.test(l)));
});
await test('Porta G: o mesmo pedido num servidor com gta_online ligada é atendido (o código vai buscar o diário)', async () => {
  const m = await mention('o que tem no gta hoje?', { guildId: G_ON });
  const textos = finalTexts(m);
  assert.ok(textos.length >= 1, 'respondeu');
  assert.ok(!textos.some((t) => /desativada neste servidor/.test(t)), textos.join(' | '));
  // a Porta G rodou: ou a IA montou a resposta com o diário, ou o próprio código disse que não conseguiu buscar (sem rede no teste)
  assert.ok(localCalls >= 1 || textos.some((t) => /GTA Online/.test(t)), `a Porta G rodou: ${textos.join(' | ')}`);
});
await test('Porta G na DM (dono): nada muda, atende', async () => {
  const m = await mention('o que tem no gta hoje?', { guildId: null, userId: OWNER });
  const textos = finalTexts(m);
  assert.ok(textos.length >= 1 && !textos.some((t) => /desativada/.test(t)), textos.join(' | '));
});
await test('Porta T: "me lembra..." num servidor com criar_lembrete desligada recebe a recusa e nada é gravado', async () => {
  const m = await mention('me lembra daqui 10 minutos de beber água', { guildId: G_OFF });
  assert.deepEqual(finalTexts(m), [recusa('criar_lembrete')]);
  assert.equal(localCalls, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'lembretes.json')) || !/beber água/.test(fs.readFileSync(path.join(tmp, 'lembretes.json'), 'utf8')), 'nenhum lembrete gravado');
});
await test('Porta T: "meus lembretes" num servidor com listar_lembretes desligada recebe a recusa', async () => {
  const m = await mention('meus lembretes', { guildId: G_OFF });
  assert.deepEqual(finalTexts(m), [recusa('listar_lembretes')]);
});
await test('Porta T: num servidor com os lembretes ligados o pedido é atendido e gravado', async () => {
  const m = await mention('me lembra daqui 10 minutos de regar as plantas', { guildId: G_ON, userId: MEMBER2 });
  const textos = finalTexts(m);
  assert.ok(textos.some((t) => /^Anotado!/.test(t)), textos.join(' | '));
  assert.match(fs.readFileSync(path.join(tmp, 'lembretes.json'), 'utf8'), /regar as plantas/);
});
await test('Porta T na DM: nada muda (o pedido é atendido)', async () => {
  const m = await mention('me lembra daqui 15 minutos de alongar', { guildId: null, userId: OWNER });
  assert.ok(finalTexts(m).some((t) => /^Anotado!/.test(t)), finalTexts(m).join(' | '));
});
// Discord falso SEM servidores em comum: o atalho responde "não encontrei a presença" (determinístico, sem rede).
llm.setDiscordClient({ user: { id: '999' }, guilds: { cache: new Map() }, channels: { cache: new Map() }, users: { cache: new Map(), fetch: async () => null } });
await test('atalho da música do status: com get_current_music desligada no servidor a resposta é a recusa (nada é identificado nem baixado)', async () => {
  const m = await mention('baixa a musica que eu to ouvindo', { guildId: G_OFF });
  assert.deepEqual(finalTexts(m), [recusa('get_current_music')]);
  assert.equal(embedsOf(m).length, 0, 'sem o embed de "Música Identificada"');
});
await test('atalho da música do status: com a ferramenta ligada o atalho roda (aqui, sem Discord, avisa que não achou a música)', async () => {
  const m = await mention('baixa a musica que eu to ouvindo', { guildId: G_ON });
  const textos = finalTexts(m);
  assert.ok(textos.length >= 1 && !textos.some((t) => /desativada neste servidor/.test(t)), textos.join(' | '));
  assert.ok(textos.some((t) => t.startsWith('🎵')), `a resposta do atalho, não a do modelo: ${textos.join(' | ')}`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('C. O /yui (ask.js) e o "+yui musica" (prefixRouter.js)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const { askCommand } = await import(pathToFileURL(path.join(repoRoot, 'src/discord/commands/ask.js')).href);
const { handlePrefixCommand } = await import(pathToFileURL(path.join(repoRoot, 'src/discord/prefixRouter.js')).href);
function fakeSlash({ userId, guildId, pergunta }) {
  const it = {
    user: { id: userId, tag: `u${userId}#0001`, username: 'ana' }, channelId: `chan-y${++seq}`, guildId, guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    deferred: false, replied: false, createdTimestamp: Date.now(), outs: [],
    isChatInputCommand: () => true,
    options: { getString: (n) => (n === 'mensagem' ? pergunta : null) },
    async deferReply() { this.deferred = true; },
    async editReply(p) { this.outs.push(p); return { id: 'e1', channel: this.channel }; },
    async reply(p) { this.replied = true; this.outs.push(p); return { id: 'r1' }; },
    async followUp(p) { this.outs.push(p); return { id: 'f1', channel: this.channel }; },
  };
  it.channel = { id: it.channelId, name: 'geral', async send(p) { it.outs.push(p); return { id: 'sent' }; } };
  return it;
}
await test('/yui num servidor com criar_lembrete desligada: a recusa, e nada é gravado', async () => {
  const it = fakeSlash({ userId: MEMBER, guildId: G_OFF, pergunta: 'me lembra daqui 20 minutos de ligar pra mãe' });
  await askCommand.execute(it);
  const textos = it.outs.map(textOf).filter((t) => t && !isProgress(t));
  assert.ok(textos.includes(recusa('criar_lembrete')), textos.join(' | '));
  assert.ok(!/ligar pra mãe/.test(fs.readFileSync(path.join(tmp, 'lembretes.json'), 'utf8')));
});
await test('/yui num servidor com os lembretes ligados e na DM: atendido como antes', async () => {
  for (const [guildId, userId, assunto] of [[G_ON, MEMBER2, 'tirar o lixo'], [null, OWNER, 'ver o forno']]) {
    const it = fakeSlash({ userId, guildId, pergunta: `me lembra daqui 25 minutos de ${assunto}` });
    await askCommand.execute(it);
    const textos = it.outs.map(textOf).filter((t) => t && !isProgress(t));
    assert.ok(textos.some((t) => /^Anotado!/.test(t)), `${guildId ?? 'DM'}: ${textos.join(' | ')}`);
  }
});
function fakePrefix(content, { guildId }) {
  const m = {
    content, author: { id: MEMBER, username: 'bob', bot: false }, guild: guildId ? { id: guildId, name: 'srv' } : null, guildId, member: null, channelId: 'chan-prefix',
    mentions: { channels: { first: () => null } }, replies: [], sent: [],
    channel: { send: async (p) => { m.sent.push(p); return { id: 'w1', edit: async () => ({ id: 'w1' }), channel: m.channel }; } },
    reply: async (p) => { m.replies.push(p); return { id: 'r1' }; },
  };
  return m;
}
const prefixo = String(config.discord.prefix || '+yui');
await test('"+yui musica <link>" num servidor com download_audio desligada: a recusa, sem tentar baixar', async () => {
  const before = legacyConfig.requireTos;
  legacyConfig.requireTos = false; // o gate de Termos de Uso não é o assunto aqui
  try {
    const m = fakePrefix(`${prefixo} musica https://exemplo.com/x`, { guildId: G_OFF });
    await handlePrefixCommand(m);
    assert.deepEqual(m.replies.map(textOf), [recusa('download_audio')]);
    assert.equal(m.sent.length, 0);
  } finally { legacyConfig.requireTos = before; }
});
await test('"+yui musica <link>" com a ferramenta ligada segue para o comando (aqui, o link inválido é recusado pelo próprio comando)', async () => {
  const before = legacyConfig.requireTos;
  legacyConfig.requireTos = false;
  try {
    const m = fakePrefix(`${prefixo} musica https://exemplo.com/x`, { guildId: G_ON });
    await handlePrefixCommand(m);
    const tudo = [...m.replies, ...m.sent].map((p) => textOf(p) || JSON.stringify(p?.embeds?.map((e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e)) ?? ''));
    assert.ok(tudo.length >= 1, 'o comando respondeu');
    assert.ok(!tudo.some((t) => /desativada neste servidor/.test(t)), tudo.join(' | '));
  } finally { legacyConfig.requireTos = before; }
});
await test('"+yui diario", "+yui semanal" e "+yui noticias" num servidor com gta_online desligada: a recusa, sem buscar nada', async () => {
  const before = legacyConfig.requireTos;
  legacyConfig.requireTos = false;
  try {
    for (const sub of ['diario', 'daily', 'semanal', 'weekly', 'noticias 2', 'news']) {
      const m = fakePrefix(`${prefixo} ${sub}`, { guildId: G_OFF });
      await handlePrefixCommand(m);
      assert.deepEqual(m.replies.map(textOf), [recusa('gta_online')], sub);
      assert.equal(m.sent.length, 0, `${sub}: nada foi enviado ao canal`);
    }
  } finally { legacyConfig.requireTos = before; }
});
await test('"+yui diario" num servidor com gta_online ligada e na DM do dono: segue para o comando (nada de recusa)', async () => {
  const before = legacyConfig.requireTos;
  legacyConfig.requireTos = false;
  try {
    for (const [guildId, autor] of [[G_ON, MEMBER], [null, OWNER]]) {
      const m = fakePrefix(`${prefixo} diario`, { guildId });
      m.author.id = autor;
      await handlePrefixCommand(m);
      const tudo = [...m.replies, ...m.sent].map((p) => textOf(p) || JSON.stringify(p?.embeds?.map((e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e)) ?? ''));
      assert.ok(tudo.length >= 1, `${guildId ?? 'DM'}: o comando respondeu`);
      assert.ok(!tudo.some((t) => /desativada neste servidor/.test(t)), `${guildId ?? 'DM'}: ${tudo.join(' | ')}`);
    }
  } finally { legacyConfig.requireTos = before; }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('D. As fontes: cada caminho passa pelo módulo');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('llmHandler: Porta G, Porta T e o atalho da música conferem o interruptor ANTES de agir; o despachante usa a mesma frase', () => {
  const src = readSrc('src/handlers/llmHandler.js');
  const g = src.indexOf("recusaSeDesligada(options.guildId || guildId, 'gta_online', isToolDisabled)");
  assert.ok(g > 0 && g < src.indexOf('const gtaAnswer = await composeGtaAnswer('), 'Porta G antes de buscar');
  const t = src.indexOf('recusaDeLembrete({ guildId: options.guildId || guildId');
  assert.ok(t > 0 && t < src.indexOf('const remRouted = await routeReminders('), 'Porta T antes de gravar');
  assert.ok(src.includes("recusaSeDesligada(options.guildId || guildId, 'get_current_music', isToolDisabled)"));
  assert.ok(src.includes('const disabledToolText = textoFerramentaDesligada(toolData.tool);'));
  assert.ok(!/A ferramenta \\`\$\{/.test(src), 'nenhuma cópia da frase à mão');
});
await test('interactionCreate, ask.js e prefixRouter usam o módulo; o /sair-call fica de fora de propósito e os /gta-* obedecem ao gta_online', () => {
  const ic = readSrc('src/events/interactionCreate.js');
  const i = ic.indexOf('recusaSeDesligada(interaction.guildId, ferramentaDoComando(commandName, interaction.options), isToolDisabled)');
  assert.ok(i > 0 && i < ic.indexOf("if (commandName === 'yui') {"), 'antes de despachar qualquer comando de barra');
  assert.ok(ic.includes("recusaSeDesligada(interaction.guildId, 'search_and_download_music', isToolDisabled)"), 'a escolha da faixa do Deezer');
  assert.ok(readSrc('src/discord/commands/ask.js').includes('recusaDeLembrete({ guildId: entry.guildId'));
  const pr = readSrc('src/discord/prefixRouter.js');
  assert.ok(pr.indexOf('recusaSeDesligada(guildDoPedido, ferramenta, isToolDisabled)') < pr.indexOf('await command.execute(adapter)'));
  assert.equal(fd.ferramentaDoComando('sair-call'), null, 'sair-call');
  for (const gta of ['gta-diario', 'gta-semanal', 'gta-noticias']) assert.equal(fd.ferramentaDoComando(gta), 'gta_online', gta);
});

// ── fim ─────────────────────────────────────────────────────────────────────────────────────────
process.chdir(repoRoot);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* arquivos ainda abertos no Windows */ }
say(`\n${failures.length === 0 ? 'ok' : 'FALHA'}: ${passed} teste(s) passaram${failures.length ? `, ${failures.length} falharam: ${failures.join('; ')}` : ''}.`);
process.exitCode = failures.length === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
