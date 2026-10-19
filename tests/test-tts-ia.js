// Testes do lado da IA da integração do TTS (pacote I1): llmHandler, persona de voz, interruptor voice_tts, painel e STT.
// Rodam SEM Discord, SEM rede e SEM os bancos reais: bancos, logs e auditoria ficam numa pasta temporária (DATABASE_DIR);
// axios/fetch/DNS/sockets são dublês e o provedor local de IA é falso. O TTS de verdade (services/tts/index.js) é iniciado com
// provedor falso e um gerenciador de saída falso, só para provar os campos que o gancho entrega a speakVoiceReply.
// Arquivos reais protegidos: as escritas em src/data/server_tools.json e no historico.txt são interceptadas pelos testes.
// Execução: npm run test:tts-ia   (node tests/test-tts-ia.js)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const say = console.log.bind(console);

// ── Ambiente isolado ────────────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-tts-ia-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_OWNER_ID: '111',
  YUI_PRIVATE_CHANNEL_IDS: 'priv1',
  YUI_MEMORY_ENABLED: 'true',
  YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  YUI_SEARCH_PROVIDERS: 'searxng',
  SEARXNG_URL: 'http://searx.invalid/',
  LOG_LEVEL: 'error',
});
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'YUI_REPLY_MAX_TOKENS', 'YUI_REPLY_MAX_PARTS',
  'YUI_CONTEXT_ENABLED', 'YUI_CONTEXT_SCOPE', 'YUI_CONTEXT_TTL_HOURS', 'YUI_CONTEXT_MAX_CHARS', 'YUI_CONTEXT_MAX_TURNS',
  'YUI_VOICE_TOOLS', 'YUI_PERSONA_VOICE_FILE', 'YUI_TTS_STALE_SECONDS', 'WITAI_TOKEN', 'WIT_AI_KEY', 'OPENAI_API_KEY', 'OPENAI_STT_KEY',
  'LOCAL_STT_URL', 'WHISPER_LOCAL_URL', 'GEMINI_MODEL_FALLBACK']) delete process.env[k];
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

// Nada sai da máquina: axios, fetch, DNS e sockets viram dublês que falham.
const { default: axios } = await import('axios');
const calls = []; // { method, url, body, config }
let postHook = null; // (url, body, config) => resposta falsa de axios, ou undefined para falhar como o resto
axios.post = async (url, body, config) => {
  calls.push({ method: 'post', url: String(url), body, config });
  const fake = postHook ? postHook(String(url), body, config) : undefined;
  if (fake) return fake;
  throw new Error('offline (teste)');
};
axios.get = async (url) => { calls.push({ method: 'get', url: String(url) }); throw new Error('offline (teste)'); };
globalThis.fetch = async (url) => { throw new Error(`fetch bloqueado no teste: ${String(url).slice(0, 40)}`); };
net.Socket.prototype.connect = function blocked() { throw new Error('rede bloqueada no teste'); };
dns.promises.lookup = async () => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; throw e; };
dns.lookup = (host, opts, cb) => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e); };

// Escritas em arquivos REAIS do projeto são interceptadas: server_tools.json (painel/interruptor) e historico.txt.
const realWriteFileSync = fs.writeFileSync;
const realAppendFile = fs.appendFile;
const interceptedToolWrites = [];
const interceptedBanWrites = [];
const historyAppends = [];
fs.writeFileSync = function guardedWrite(file, ...rest) {
  if (String(file).endsWith(path.join('data', 'server_tools.json'))) { interceptedToolWrites.push(String(file)); return undefined; }
  if (String(file).endsWith(path.join('data', 'bans.json'))) { interceptedBanWrites.push(String(file)); return undefined; }
  return realWriteFileSync.call(this, file, ...rest);
};
fs.appendFile = function guardedAppend(file, data, cb) {
  if (String(file).endsWith(path.join('data', 'historico.txt'))) {
    historyAppends.push(String(file));
    if (typeof cb === 'function') cb(null);
    return undefined;
  }
  return realAppendFile.call(this, file, data, cb);
};

// ── Mini-runner ─────────────────────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const test = async (name, fn) => {
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
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const waitFor = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !pred()) await sleep(20); return pred(); };

// ── Módulos sob teste ───────────────────────────────────────────────────────────────────────────
const { default: config } = await import('../src/config/index.js');
config.saveHistory = false; // só os testes de moderação ligam (e a escrita é interceptada acima)
const llm = await import('../src/handlers/llmHandler.js');
const persona = await import('../src/core/persona.js');
const guards = await import('../src/services/tts/voiceGuards.js');
const tts = await import('../src/services/tts/index.js');
const { createFakeProvider } = await import('../src/services/tts/providers/fake.js');
const core = await import('../src/core/index.js');
await core.initMemory();
const ctxMod = await import('../src/core/context/contextStore.js');
const panel = await import('../src/handlers/mcpToolPanelHandler.js');
const ban = await import('../src/handlers/banHandler.js');
const { playlistNote } = await import('../src/discord/commands/baixarMusica.js');
const { downloadPlaylistNote } = await import('../src/handlers/llmSafety.js');
console.log = console.warn = console.error = () => {}; // o llmHandler é falante; o resultado sai por say()

const VOICE_REFUSAL = 'Isso eu faço só pelo chat.';
const GUILD = 'g-voice';
const TEXT_CHANNEL = 'chan-text';

// ── Provedor local de IA falso (o primeiro da cadeia) ────────────────────────────────────────────
function sse(text, finish = 'stop', model = 'modelo-falso') {
  const chunks = [];
  const n = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += n) chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: { content: text.slice(i, i + n) }, finish_reason: null }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return Readable.from(chunks);
}
let localScript = [];
let localCalls = [];
let localDown = false;
let localResponder = null; // (corpo) => { text, finish } | null: responde pelo CONTEÚDO do pedido (o roteiro fixo se perde quando há chamadas extras)
function localLlmHook(url, body) {
  if (url !== config.localLlmUrl) return undefined;
  localCalls.push(body);
  if (localDown) return undefined;
  const step = (localResponder && localResponder(body)) || (localScript.length ? localScript.shift() : { text: 'Resposta padrão do teste.', finish: 'stop' });
  return { data: sse(step.text, step.finish) };
}
postHook = localLlmHook;
const resetLocal = (script = []) => { localScript = script.slice(); localCalls = []; localDown = false; localResponder = null; calls.length = 0; };
const lastMessages = () => localCalls.at(-1)?.messages ?? [];
const systemOf = (messages) => messages[0]?.content ?? '';
const historyPart = (messages) => messages.slice(1, -1).map((m) => `${m.role}:${m.content}`);

// ── TTS de verdade, com provedor e gerenciador de saída falsos ───────────────────────────────────
const captured = []; // { guildId, job }
const interrupts = []; // [guildId, motivo]
const fakeManager = {
  enqueue(guildId, job) { captured.push({ guildId, job }); return { ok: true }; },
  interrupt(guildId, reason) { interrupts.push([guildId, reason]); return false; },
  dispose() { return false; },
  disposeAll() {},
  isSpeaking() { return false; },
  overlapsSpeech() { return false; },
  noteHumanSpeaking() {},
  warmup() {},
  getStatus() { return { count: 0, guilds: [] }; },
};
const initResult = await tts.initTts({
  deps: {
    isEnabled: () => true, isBanned: () => false, isBot: () => false, isRadioActive: () => false, isAiCallActive: () => true,
    isUserInSameVoice: () => true, canSpeakInChannel: () => true, containsForbidden: () => false, matchesTrigger: () => false,
    resolveName: () => null, isOpusAvailable: () => true,
  },
  overrides: {
    providers: [createFakeProvider({ name: 'fake' })],
    manager: fakeManager,
    config: { userGapSeconds: 0, userPerMin: 60, guildPerMin: 120, globalPerMin: 240, guildSecondsPer10Min: 1200 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  },
});

// ── Mensagens falsas do Discord ──────────────────────────────────────────────────────────────────
/** Mensagem de voz como a do voiceHandler: isVoice, canal de texto REAL, autor humano. */
function fakeVoiceMessage({ userId = '222', guildId = GUILD, channelId = TEXT_CHANNEL, content = 'qual a capital da Austrália' } = {}) {
  const finals = [];
  const channel = { id: channelId, name: 'geral', send: async () => ({ id: 'sent' }) };
  const replyMsg = {
    id: 'proc',
    channel,
    async edit(p) {
      if (String(p.content ?? '').includes('Processando')) return replyMsg;
      finals.push(p);
      return replyMsg;
    },
  };
  return {
    id: `voice_${Math.random().toString(36).slice(2, 8)}`,
    isVoice: true,
    content,
    author: { id: userId, username: `u${userId}`, tag: `u${userId}#0001`, bot: false },
    guild: { id: guildId, name: 'Servidor Voz' },
    guildId,
    channel,
    channelId,
    mentions: { has: () => false, everyone: false },
    finals,
    async reply() { return replyMsg; },
  };
}
/** Mensagem de texto (menção à Yui), como a do test-context. */
function fakeTextMessage({ userId = '222', channelId = TEXT_CHANNEL, guildId = GUILD, content = '<@999> oi' } = {}) {
  const finals = [];
  const msg = {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content,
    channelId, guildId, guild: { id: guildId, name: 'Servidor Voz' },
    author: { id: userId, tag: `u${userId}#0001`, bot: false },
    client: { user: { id: '999' } },
    mentions: { has: () => true, everyone: false, repliedUser: null },
    channel: { id: channelId, name: 'geral', send: async () => ({ id: 'sent' }) },
    finals,
    async reply() { return replyMsg; },
  };
  const replyMsg = {
    id: 'proc', channel: msg.channel,
    async edit(p) {
      if (String(p.content ?? '').includes('Processando')) return replyMsg;
      finals.push(p);
      return replyMsg;
    },
  };
  return msg;
}
const hasText = (m) => m.finals.some((p) => typeof p.content === 'string' && p.content.length > 0);
const hasEmbed = (m) => m.finals.some((p) => Array.isArray(p.embeds) && p.embeds.length > 0);
const lastText = (m) => [...m.finals].reverse().find((p) => typeof p.content === 'string' && p.content.length > 0)?.content ?? '';

/** Opções que o voiceHandler passa ao addToQueue. */
function voiceOptions(transcript, over = {}) {
  return { voice: true, voiceTranscript: transcript, disableTools: true, voiceRequestedAt: Date.now(), ...over };
}
/** Enfileira e espera a resposta (a fila libera o item seguinte até 1 s depois do anterior). */
async function run(msg, prompt, options, { script = null, until = hasText, type = 'mention', responder = null } = {}) {
  resetLocal(script ?? [{ text: 'Resposta padrão do teste.', finish: 'stop' }]);
  localResponder = responder;
  await llm.addToQueue(prompt, msg, type, { allowSearch: false, guildId: msg.guildId, ...options });
  const done = await waitFor(() => until(msg), 40000);
  assert.ok(done, 'a fila não terminou');
  await sleep(200); // o que vem depois da entrega (histórico, log) roda logo em seguida
  return msg;
}
const skipped = () => tts.getTtsStatus().counters.skipped;

/** Executa fn com a escrita de server_tools.json interceptada (o painel e o interruptor gravam nesse arquivo). */
async function toolsSandbox(fn) {
  const before = interceptedToolWrites.length;
  try {
    return await fn();
  } finally {
    for (const g of ['g-sw-1', 'g-sw-2', 'g-panel-1', 'g-panel-2']) llm.resetServerTools(g);
    assert.ok(interceptedToolWrites.length >= before, 'as escritas ficam interceptadas');
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('A. mcp_tools.json, interruptor voice_tts e filtro switchOnly');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const tools = JSON.parse(read('src/data/mcp_tools.json'));
const ORIGINAL_TOOLS = ['search_and_download_music', 'download_audio', 'download_video', 'search_game', 'search_web', 'generate_reply', 'show_bot_menu',
  'generate_image', 'check_steam', 'convert_currency', 'ia_automod', 'join_voice_call', 'leave_voice_call', 'radio_voice_stt', 'get_current_music',
  'check_game_info', 'check_pc_compatibility'];

await test('voice_tts existe, é switchOnly + defaultDisabled + disableable, sem gatilhos nem parâmetros; as outras 17 ferramentas seguem na mesma ordem', () => {
  const names = tools.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, 'nomes repetidos');
  assert.deepEqual(names.filter((n) => n !== 'voice_tts'), ORIGINAL_TOOLS, 'as ferramentas existentes mudaram');
  const t = tools.find((x) => x.function.name === 'voice_tts');
  assert.ok(t, 'voice_tts não existe');
  assert.equal(t.meta.switchOnly, true);
  assert.equal(t.meta.defaultDisabled, true);
  assert.equal(t.meta.disableable, true);
  assert.ok(t.meta.label.includes('Resposta por Voz'));
  assert.equal(t.function.textual_triggers, undefined, 'sem gatilhos textuais');
  assert.deepEqual(t.function.parameters, { type: 'object', properties: {}, required: [] });
  assert.equal(t.type, 'function');
});
await test('padrão: voice_tts DESLIGADO em qualquer servidor (e sem servidor)', () => {
  assert.equal(llm.isToolDisabled('g-sw-1', 'voice_tts'), true);
  assert.equal(llm.isToolDisabled(null, 'voice_tts'), true);
  assert.ok(llm.getDisabledTools('g-sw-1').includes('voice_tts'));
  assert.ok(llm.getAllMcpTools().some((t) => t.function.name === 'voice_tts'));
});
await test('LIGADO no servidor: continua invisível para a IA (buildToolsPayload e buildToolsDefinition), e as outras ferramentas aparecem', () => toolsSandbox(async () => {
  assert.equal(llm.setServerToolEnabled('g-sw-1', 'voice_tts', true), true);
  assert.equal(llm.isToolDisabled('g-sw-1', 'voice_tts'), false, 'o interruptor deveria ter ligado');
  assert.ok(!llm.getDisabledTools('g-sw-1').includes('voice_tts'));
  const payload = llm.buildToolsPayload('g-sw-1', null);
  assert.ok(!payload.some((t) => t.function.name === 'voice_tts'), 'a IA recebeu o interruptor na lista de ferramentas');
  assert.ok(payload.some((t) => t.function.name === 'search_web'), 'as demais ferramentas devem continuar');
  const definition = llm.buildToolsDefinition('g-sw-1', null);
  assert.ok(!definition.includes('voice_tts'), 'o texto de ferramentas citou o interruptor');
  assert.ok(definition.includes('search_web'));
  assert.ok(interceptedToolWrites.length > 0, 'a gravação do server_tools.json deveria ter sido interceptada');
}));
await test('voice_tts NÃO está na lista VOICE_TOOLS: ligar/desligar entrar-na-call não mexe nele (e vice-versa)', () => toolsSandbox(async () => {
  llm.setServerToolEnabled('g-sw-2', 'join_voice_call', true);
  assert.equal(llm.isToolDisabled('g-sw-2', 'join_voice_call'), false);
  assert.equal(llm.isToolDisabled('g-sw-2', 'leave_voice_call'), false);
  assert.equal(llm.isToolDisabled('g-sw-2', 'voice_tts'), true, 'entrar na call não pode ligar a fala');
  llm.setServerToolEnabled('g-sw-2', 'voice_tts', true);
  llm.setServerToolEnabled('g-sw-2', 'join_voice_call', false);
  assert.equal(llm.isToolDisabled('g-sw-2', 'voice_tts'), false, 'sair da call não pode desligar a fala');
  llm.setServerToolEnabled('g-sw-2', 'voice_tts', false);
  assert.equal(llm.isToolDisabled('g-sw-2', 'voice_tts'), true);
}));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('B. Painel de ferramentas (mcpToolPanelHandler)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
function fakePanelInteraction({ customId, guildId, values } = {}) {
  const log = { update: [], reply: [] };
  return {
    customId, guildId, guild: guildId ? { id: guildId } : null, user: { id: '999' }, values,
    member: { permissions: { has: () => true } },
    update: async (p) => { log.update.push(p); },
    reply: async (p) => { log.reply.push(p); },
    log,
  };
}
await test('a descrição de voice_tts tem o texto combinado', () => {
  const src = read('src/handlers/mcpToolPanelHandler.js');
  assert.ok(src.includes("'voice_tts': '**Propósito:** Quando ligado, a Yui responde falando na call a quem pedir por voz. Vale para todos na call. Desligado por padrão."));
});
await test('o painel lista voice_tts e o menu não passa de 25 opções', async () => {
  const it = fakePanelInteraction({ customId: 'x', guildId: 'g-panel-1' });
  await panel.sendMcpToolsManager(it, 'g-panel-1', null, false, true);
  const row = it.log.reply[0].components[0].toJSON();
  const options = row.components[0].options;
  assert.ok(options.some((o) => o.value === 'voice_tts'), 'voice_tts não aparece no menu');
  assert.ok(options.length <= 25, `menu com ${options.length} opções`);
  const detail = fakePanelInteraction({ customId: 'x', guildId: 'g-panel-1' });
  await panel.sendMcpToolsManager(detail, 'g-panel-1', 'voice_tts', true);
  const embed = detail.log.update[0].embeds[0].toJSON();
  assert.ok(embed.description.includes('Quando ligado, a Yui responde falando na call'), 'a descrição detalhada deveria aparecer');
  assert.ok(embed.description.includes('DESATIVADA'), 'padrão desligado');
});
await test('toggle: só vale no servidor onde o painel foi aberto (outro servidor e DM são recusados, sem mudar nada)', () => toolsSandbox(async () => {
  const other = fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_on', guildId: 'g-panel-2' });
  await panel.handleMcpToolInteraction(other);
  assert.equal(other.log.reply.length, 1, 'deveria responder recusando');
  assert.equal(other.log.reply[0].ephemeral, true);
  assert.equal(other.log.update.length, 0);
  assert.equal(llm.isToolDisabled('g-panel-1', 'voice_tts'), true, 'mudou o servidor errado');
  const dm = fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_on', guildId: null });
  await panel.handleMcpToolInteraction(dm);
  assert.equal(dm.log.reply.length, 1);
  assert.equal(llm.isToolDisabled('g-panel-1', 'voice_tts'), true, 'DM mexeu no servidor');
  const ok = fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_on', guildId: 'g-panel-1' });
  await panel.handleMcpToolInteraction(ok);
  assert.equal(ok.log.update.length, 1, 'no servidor certo o painel atualiza');
  assert.equal(llm.isToolDisabled('g-panel-1', 'voice_tts'), false, 'deveria ter ligado');
  const off = fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_off', guildId: 'g-panel-1' });
  await panel.handleMcpToolInteraction(off);
  assert.equal(llm.isToolDisabled('g-panel-1', 'voice_tts'), true);
}));
await test('select e voltar: também só mostram o servidor onde o painel foi aberto (outro servidor e DM são recusados)', () => toolsSandbox(async () => {
  for (const customId of ['srvmcp_select_g-panel-1', 'srvmcp_back_g-panel-1']) {
    const other = fakePanelInteraction({ customId, guildId: 'g-panel-2', values: ['voice_tts'] });
    await panel.handleMcpToolInteraction(other);
    assert.equal(other.log.reply.length, 1, `${customId}: deveria recusar`);
    assert.equal(other.log.reply[0].ephemeral, true);
    assert.equal(other.log.update.length, 0, `${customId}: não pode mostrar as ferramentas de outro servidor`);
    const dm = fakePanelInteraction({ customId, guildId: null, values: ['voice_tts'] });
    await panel.handleMcpToolInteraction(dm);
    assert.equal(dm.log.reply.length, 1);
    assert.equal(dm.log.update.length, 0);
    const own = fakePanelInteraction({ customId, guildId: 'g-panel-1', values: ['voice_tts'] });
    await panel.handleMcpToolInteraction(own);
    assert.equal(own.log.update.length, 1, `${customId}: no servidor certo atualiza`);
    assert.equal(own.log.reply.length, 0);
  }
}));
await test('desligar a resposta por voz CORTA a fala em curso (interruptSpeech "switch-off"); ligar não corta; o reset (padrão = desligado) corta', () => toolsSandbox(async () => {
  interrupts.length = 0;
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_on', guildId: 'g-panel-1' }));
  assert.deepEqual(interrupts, [], 'ligar não interrompe nada');
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_search_web_off', guildId: 'g-panel-1' }));
  assert.deepEqual(interrupts, [], 'desligar OUTRA ferramenta não interrompe a fala');
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_off', guildId: 'g-panel-1' }));
  assert.deepEqual(interrupts, [['g-panel-1', 'switch-off']]);
  // pedido de OUTRO servidor (recusado) não corta a fala daqui
  llm.setServerToolEnabled('g-panel-1', 'voice_tts', true);
  interrupts.length = 0;
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_toggle_g-panel-1_voice_tts_off', guildId: 'g-panel-2' }));
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_reset_g-panel-1', guildId: 'g-panel-2' }));
  assert.deepEqual(interrupts, []);
  // o reset volta o voice_tts ao padrão (desligado): estava ligado, então corta; com ele já desligado não corta de novo
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_reset_g-panel-1', guildId: 'g-panel-1' }));
  assert.deepEqual(interrupts, [['g-panel-1', 'switch-off']]);
  interrupts.length = 0;
  await panel.handleMcpToolInteraction(fakePanelInteraction({ customId: 'srvmcp_reset_g-panel-1', guildId: 'g-panel-1' }));
  assert.deepEqual(interrupts, [], 'o reset com a resposta por voz já desligada não interrompe nada');
}));
await test('o corte da fala ao desligar o interruptor vale por QUALQUER caminho que chame setServerToolEnabled (/yui-ferramentas, painel do dono)', () => toolsSandbox(async () => {
  interrupts.length = 0;
  llm.setServerToolEnabled('g-sw-1', 'voice_tts', true);
  assert.deepEqual(interrupts, []);
  llm.setServerToolEnabled('g-sw-1', 'search_web', false);
  assert.deepEqual(interrupts, [], 'outra ferramenta não corta a fala');
  llm.setServerToolEnabled('g-sw-1', 'voice_tts', false);
  assert.deepEqual(interrupts, [['g-sw-1', 'switch-off']]);
  // o painel não duplica o corte (ele só chama setServerToolEnabled)
  const panelSrc = read('src/handlers/mcpToolPanelHandler.js');
  assert.ok(!/interruptSpeech/.test(panelSrc), 'o corte fica num lugar só (llmHandler)');
  assert.ok(/stopSpeechOfSwitchedOffGuild\(guildId\);\s+return true;/.test(read('src/handlers/llmHandler.js')), 'setServerToolEnabled corta ao desligar');
}));
await test('reset: também só vale no servidor onde o painel foi aberto', () => toolsSandbox(async () => {
  llm.setServerToolEnabled('g-panel-1', 'voice_tts', true);
  const other = fakePanelInteraction({ customId: 'srvmcp_reset_g-panel-1', guildId: 'g-panel-2' });
  await panel.handleMcpToolInteraction(other);
  assert.equal(other.log.reply.length, 1);
  assert.equal(llm.isToolDisabled('g-panel-1', 'voice_tts'), false, 'o reset de outro servidor mexeu aqui');
  const own = fakePanelInteraction({ customId: 'srvmcp_reset_g-panel-1', guildId: 'g-panel-1' });
  await panel.handleMcpToolInteraction(own);
  assert.equal(own.log.update.length, 1);
  assert.equal(llm.isToolDisabled('g-panel-1', 'voice_tts'), true, 'o reset deveria voltar ao padrão (desligado)');
}));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('C. Persona de voz (core/persona.js)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// O arquivo de voz só vale dentro de persona/ (o conteúdo vai ao prompt de todo pedido de voz): o temporário do teste fica lá e some no fim.
const personaDir = path.join(repoRoot, 'persona');
const tmpVoiceName = `tmp-yui-voz-${process.pid}.md`;
const tmpVoiceFile = path.join(personaDir, tmpVoiceName);
const relVoice = `persona/${tmpVoiceName}`;
const VOICE_DEFAULT = path.join(repoRoot, 'persona', 'yui-voz.md');
await test('arquivo padrão persona/yui-voz.md: o bloco começa com [MODO VOZ] e tem as regras principais', () => {
  delete process.env.YUI_PERSONA_VOICE_FILE;
  assert.equal(path.resolve(persona.resolveVoicePersonaFile()), VOICE_DEFAULT);
  const text = persona.voicePersonaText();
  assert.ok(text.startsWith('[MODO VOZ]'));
  assert.ok(/1 ou 2 frases curtas/.test(text) && /dados pessoais/.test(text) && /chat/.test(text));
  assert.ok(persona.VOICE_PERSONA_FALLBACK.startsWith('[MODO VOZ]'));
});
await test('applyVoicePersona põe o bloco no FIM do prompt (e preserva o começo)', () => {
  const out = persona.applyVoicePersona('PROMPT-BASE\n[MEMÓRIA]\nMARCA-MEM\n');
  assert.ok(out.startsWith('PROMPT-BASE\n[MEMÓRIA]\nMARCA-MEM\n'));
  assert.ok(out.endsWith(persona.voicePersonaText()));
  assert.ok(out.indexOf('MARCA-MEM') < out.indexOf('[MODO VOZ]'));
  assert.equal(persona.applyVoicePersona(undefined), `\n\n${persona.voicePersonaText()}`);
});
await test('arquivo ausente (ou vazio) usa o texto de reserva; nunca lança', () => {
  process.env.YUI_PERSONA_VOICE_FILE = 'persona/nao-existe-xyz.md';
  assert.equal(persona.voicePersonaText(), persona.VOICE_PERSONA_FALLBACK);
  assert.ok(persona.applyVoicePersona('X').endsWith(persona.VOICE_PERSONA_FALLBACK));
  try {
    fs.writeFileSync(tmpVoiceFile, '   \r\n  ', 'utf8');
    process.env.YUI_PERSONA_VOICE_FILE = relVoice;
    assert.equal(persona.voicePersonaText(), persona.VOICE_PERSONA_FALLBACK, 'arquivo vazio');
  } finally {
    fs.rmSync(tmpVoiceFile, { force: true });
    delete process.env.YUI_PERSONA_VOICE_FILE;
  }
});
await test('relê o arquivo quando ele muda (data de modificação), com fim de linha CRLF normalizado', () => {
  try {
    fs.writeFileSync(tmpVoiceFile, '[MODO VOZ] versão UM\r\n- regra a', 'utf8');
    process.env.YUI_PERSONA_VOICE_FILE = relVoice;
    assert.equal(persona.voicePersonaText(), '[MODO VOZ] versão UM\n- regra a');
    fs.writeFileSync(tmpVoiceFile, '[MODO VOZ] versão DOIS', 'utf8');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(tmpVoiceFile, later, later);
    assert.equal(persona.voicePersonaText(), '[MODO VOZ] versão DOIS', 'não releu o arquivo alterado');
    fs.rmSync(tmpVoiceFile, { force: true });
    assert.equal(persona.voicePersonaText(), persona.VOICE_PERSONA_FALLBACK, 'arquivo removido volta à reserva');
  } finally {
    fs.rmSync(tmpVoiceFile, { force: true });
    delete process.env.YUI_PERSONA_VOICE_FILE;
  }
});
await test('caminho restrito: absoluto de fora, "..", segredos, oculto e extensão estranha caem no arquivo padrão', () => {
  const root = repoRoot;
  const expectDefault = (value) => assert.equal(path.resolve(persona.resolveVoicePersonaFile(value)), VOICE_DEFAULT, `aceitou: ${value}`);
  expectDefault('C:\\Windows\\win.ini');
  expectDefault('/etc/passwd');
  expectDefault('../fora-do-projeto.md');
  expectDefault('persona/../../fora.md');
  expectDefault('.env');
  expectDefault('secrets/chave.md');
  expectDefault('database/core.db');
  expectDefault('package.json');
  expectDefault('src/index.js');
  expectDefault('persona/.oculto.md');
  expectDefault('');
  expectDefault(undefined);
  // Dados do projeto que NUNCA podem virar prompt, mesmo sendo .md/.txt dentro da pasta do projeto (achado da revisão de segurança).
  expectDefault('src/data/youtube_cookies.txt');
  expectDefault('src/data/historico.txt');
  expectDefault('knowledge/00_regras_ia.md');
  expectDefault('docs/content_pt/TTS.md');
  expectDefault('README.md');
  expectDefault('tests/fixtures/qualquer.md');
  expectDefault('persona');
  expectDefault('personas/yui.md');
  expectDefault('persona/../knowledge/00_regras_ia.md');
  // dentro de persona/ e com extensão permitida: aceita (inclusive caminho absoluto DENTRO da pasta)
  assert.equal(path.resolve(persona.resolveVoicePersonaFile('persona/yui-publica.md')), path.join(root, 'persona', 'yui-publica.md'));
  assert.equal(path.resolve(persona.resolveVoicePersonaFile('persona/sub/pasta/voz.txt')), path.join(root, 'persona', 'sub', 'pasta', 'voz.txt'));
  assert.equal(path.resolve(persona.resolveVoicePersonaFile(path.join(root, 'persona', 'yui-voz.md'))), VOICE_DEFAULT);
});
await test('o arquivo de persona não pode virar o .env por um caminho disfarçado (nenhum conteúdo de .env sai)', () => {
  process.env.YUI_PERSONA_VOICE_FILE = 'persona/../.env';
  try {
    assert.equal(path.resolve(persona.resolveVoicePersonaFile()), VOICE_DEFAULT);
  } finally {
    delete process.env.YUI_PERSONA_VOICE_FILE;
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('D. generateResponse: persona de voz no FIM do prompt e ferramentas desligadas');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('voz: o bloco [MODO VOZ] é o ÚLTIMO do prompt de sistema, depois da memória; sem voz o bloco não aparece', async () => {
  const memoryBlock = '\n[MEMÓRIA SOBRE ESTE USUÁRIO]\nMARCA-MEM-QZ1\n';
  resetLocal([{ text: 'ok' }]);
  await llm.generateResponse('oi', 'canal-d1', { voice: true, memoryBlock, allowSearch: false, guildId: GUILD, userId: '222' });
  const sys = systemOf(lastMessages());
  assert.ok(sys.includes('[MODO VOZ]'), 'faltou o bloco de voz');
  assert.ok(sys.endsWith(persona.voicePersonaText()), 'o bloco de voz deveria ser o último');
  assert.ok(sys.indexOf('MARCA-MEM-QZ1') > -1 && sys.indexOf('MARCA-MEM-QZ1') < sys.indexOf('[MODO VOZ]'), 'a memória deveria vir ANTES do bloco de voz');
  assert.ok(sys.indexOf('[IDENTIDADE') < sys.indexOf('[MODO VOZ]'));
  resetLocal([{ text: 'ok' }]);
  await llm.generateResponse('oi', 'canal-d1', { memoryBlock, allowSearch: false, guildId: GUILD, userId: '222', disableTools: true });
  assert.ok(!systemOf(lastMessages()).includes('[MODO VOZ]'), 'texto não pode receber o bloco de voz');
});
await test('voz: provedores anônimos também recebem o bloco de voz (e continuam sem a memória)', async () => {
  resetLocal([]);
  localDown = true;
  await llm.generateResponse('oi', 'canal-d2', { voice: true, memoryBlock: '\n[MEMÓRIA]\nMARCA-MEM-QZ2\n', allowSearch: false, guildId: GUILD, userId: '222' });
  const polli = calls.find((c) => c.method === 'post' && /pollinations/i.test(c.url));
  assert.ok(polli, 'o Pollinations deveria ter sido tentado');
  const sys = polli.body.messages[0].content;
  assert.ok(sys.endsWith(persona.voicePersonaText()), 'o bloco de voz deveria estar no prompt anônimo');
  assert.ok(!sys.includes('MARCA-MEM-QZ2'), 'a memória vazou para o provedor anônimo');
  localDown = false;
});
await test('voz: generateResponse fecha a OFERTA de ferramentas sozinho (YUI_VOICE_TOOLS != true) e a reabre com YUI_VOICE_TOOLS=true', async () => {
  const hasToolsText = (sys) => sys.includes('search_web') && sys.includes('Gatilhos');
  resetLocal([{ text: 'ok' }]);
  await llm.generateResponse('pesquise algo', 'canal-d3', { voice: true, allowSearch: false, guildId: GUILD, userId: '222' });
  assert.ok(!hasToolsText(systemOf(lastMessages())), 'a lista de ferramentas foi oferecida na voz');
  process.env.YUI_VOICE_TOOLS = 'true';
  try {
    resetLocal([{ text: 'ok' }]);
    await llm.generateResponse('pesquise algo', 'canal-d3', { voice: true, allowSearch: false, guildId: GUILD, userId: '222' });
    assert.ok(hasToolsText(systemOf(lastMessages())), 'com YUI_VOICE_TOOLS=true a oferta deveria voltar');
  } finally {
    delete process.env.YUI_VOICE_TOOLS;
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('E. Guardas puras (voiceToolBlocked, gameInfoErrorText, musicDeliveryText)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('voiceToolBlocked: voz bloqueia toda ferramenta (menos generate_reply); YUI_VOICE_TOOLS=true libera; texto nunca bloqueia', () => {
  const voice = { voice: true };
  for (const name of ['download_audio', 'download_video', 'search_and_download_music', 'search_game', 'search_web', 'generate_image', 'check_steam',
    'convert_currency', 'check_game_info', 'check_pc_compatibility', 'get_current_music', 'show_bot_menu', 'get_help', 'join_voice_call',
    'leave_voice_call', 'ia_automod', 'radio_play_music', 'qualquer_coisa']) {
    assert.equal(llm.voiceToolBlocked(name, voice, {}), true, name);
  }
  assert.equal(llm.voiceToolBlocked('generate_reply', voice, {}), false, 'generate_reply é só o texto da resposta');
  assert.equal(llm.voiceToolBlocked(null, voice, {}), false);
  assert.equal(llm.voiceToolBlocked('', voice, {}), false);
  assert.equal(llm.voiceToolBlocked('download_audio', voice, { YUI_VOICE_TOOLS: 'true' }), false);
  assert.equal(llm.voiceToolBlocked('download_audio', voice, { YUI_VOICE_TOOLS: 'TRUE ' }), false);
  assert.equal(llm.voiceToolBlocked('download_audio', voice, { YUI_VOICE_TOOLS: 'false' }), true);
  assert.equal(llm.voiceToolBlocked('download_audio', voice, { YUI_VOICE_TOOLS: '1' }), true, 'só "true" libera');
  assert.equal(llm.voiceToolBlocked('download_audio', {}, {}), false);
  assert.equal(llm.voiceToolBlocked('download_audio', undefined, {}), false);
  assert.equal(llm.voiceToolBlocked('download_audio', { voice: 'true' }, {}), false, 'só o booleano true marca voz');
  assert.equal(guards.VOICE_TOOL_REFUSAL, VOICE_REFUSAL);
});
await test('gameInfoErrorText: resposta natural da IA > frase do gameInfoHandler > frase fixa; nunca texto técnico', () => {
  const f = llm.gameInfoErrorText;
  assert.equal(f({ infoError: 'x', fallbackText: 'Não achei infos completas desse jogo, tenta outra fonte.', gameQuery: 'Jogo' }), 'Não achei infos completas desse jogo, tenta outra fonte.');
  const known = 'Não consegui encontrar dados sobre "Jogo Xis" em nenhuma fonte.';
  assert.equal(f({ infoError: known, fallbackText: null, gameQuery: 'Jogo Xis' }), known);
  assert.equal(f({ infoError: 'Preciso do nome do jogo pra consultar.', gameQuery: '' }), 'Preciso do nome do jogo pra consultar.');
  // resposta da IA que parece JSON de ferramenta, erro de sistema ou aviso de limite: não vai ao usuário
  for (const bad of ['{"tool":"search_web","args":{}}', '⚠️ SYSTEM ERROR: boom', '⚡ **Limites de Processamento Atingidos:** tente depois', '❌ falhou', 'tool_code print(x)']) {
    const out = f({ infoError: known, fallbackText: bad, gameQuery: 'Jogo Xis' });
    assert.equal(out, known, `usou a resposta ruim: ${bad}`);
  }
  // frase técnica do gameInfoHandler também não passa
  for (const tech of ['Error: connect ECONNREFUSED 127.0.0.1:443', 'Request failed with status code 500', 'at fetch (https://api.rawg.io/x)', '{"error":"x"}', 'TypeError: x is undefined']) {
    const out = f({ infoError: tech, fallbackText: '', gameQuery: 'Zelda' });
    assert.equal(out, 'Não consegui achar informações sobre "Zelda" agora. Tente outro nome ou peça uma pesquisa na web.', `vazou: ${tech}`);
  }
  // nome limpo (sem crase, aspas, arroba, markdown) e curto; sem nome vira frase genérica
  const dirty = f({ gameQuery: '`@everyone` "Jogo*_ ~|<>" ' + 'x'.repeat(100) });
  assert.ok(!dirty.includes('@') && !dirty.includes('`') && !/[*_~|<>\\]/.test(dirty), dirty);
  assert.ok(dirty.length < 200, `frase longa demais: ${dirty.length}`);
  assert.ok(dirty.includes('Jogo') && dirty.includes('everyone'), dirty);
  assert.equal(f({}), 'Não consegui achar informações desse jogo agora. Tente outro nome ou peça uma pesquisa na web.');
  assert.equal(f({ fallbackText: 'a'.repeat(1501), gameQuery: 'A' }), 'Não consegui achar informações sobre "A" agora. Tente outro nome ou peça uma pesquisa na web.', 'resposta enorme não é usada');
});
await test('musicDeliveryText: com plano B mostra o aviso do plano B (e não "alta qualidade via Deezer"); sem plano B, a frase de sempre', () => {
  const normal = '✅ `Faixa - Artista`';
  assert.equal(llm.musicDeliveryText({ success: true }, normal), normal);
  assert.equal(llm.musicDeliveryText({ success: true, fallback: null }, normal), normal);
  assert.equal(llm.musicDeliveryText(null, normal), normal);
  assert.equal(llm.musicDeliveryText(undefined, normal), normal);
  const viaYoutube = {
    success: true,
    track: { title: 'Faixa', artist: 'Artista (baixado do YouTube)' },
    originalTrack: { title: 'Faixa', artist: 'Artista' },
    fallback: { source: 'youtube', reason: 'DEEZER_ERROR', youtubeTitle: 'x' },
    notice: '⚠️ Não consegui baixar pelo Deezer, então baixei do YouTube ("x"). A qualidade pode ser menor e pode não ser a versão de estúdio.',
  };
  // Decisão do dono (14/10): a entrega NÃO diz de onde veio o arquivo. O aviso hostil acima (que cita Deezer e YouTube) é trocado
  // pelo aviso neutro do mediaUrls.js; a origem só aparece nos logs.
  const out = llm.musicDeliveryText(viaYoutube, normal);
  assert.ok(out.startsWith('⚠️ Aviso: a qualidade desta faixa pode ser menor que a original'), out);
  assert.ok(out.includes('`Faixa - Artista`'), 'a faixa original deve aparecer');
  assert.ok(!/alta qualidade/i.test(out), 'não pode afirmar alta qualidade no plano B');
  assert.ok(!/deezer|youtube|spotify|yt-dlp|spotdl|deemix/i.test(out), `o texto entregue não pode citar a origem: ${out}`);
  const noNotice = llm.musicDeliveryText({ ...viaYoutube, notice: undefined }, normal);
  assert.ok(noNotice.startsWith('⚠️ Aviso: a qualidade desta faixa pode ser menor que a original'), 'sem notice usa o aviso neutro do plano B');
  assert.ok(!/deezer|youtube|spotify|yt-dlp|spotdl|deemix/i.test(noNotice), `o aviso padrão não pode citar a origem: ${noNotice}`);
});
await test('os 3 pontos de entrega do Deezer (busca+download, status e atalho) usam musicDeliveryText', () => {
  const src = read('src/handlers/llmHandler.js');
  const uses = src.match(/(?<!function )musicDeliveryText\(musicResult,/g) || [];
  assert.equal(uses.length, 3, `esperava 3 usos, achei ${uses.length}`);
  assert.ok(!/alta qualidade (baixada )?via Deezer/i.test(src), 'não deve afirmar alta qualidade via Deezer');
});
await test('playlist no download de áudio por link: a linha do llmHandler é idêntica à do /baixar_musica (playlistNote)', () => {
  for (const info of [{ playlistOnly: true }, { playlistIgnored: true }, { playlistOnly: true, playlistIgnored: true }, {}, { filePath: 'x' }]) {
    assert.equal(downloadPlaylistNote(info), playlistNote(info), JSON.stringify(info));
  }
  assert.equal(downloadPlaylistNote({ playlistOnly: true }), '\n-# Link de playlist: baixei só a primeira faixa.');
  assert.equal(downloadPlaylistNote({ playlistIgnored: true }), '\n-# O link tinha uma playlist; baixei só este vídeo.');
  assert.equal(downloadPlaylistNote(undefined), '');
  const src = read('src/handlers/llmHandler.js');
  const i = src.indexOf("toolData.tool === 'download_audio'");
  const block = src.slice(i, src.indexOf("toolData.tool === 'get_current_music'"));
  assert.ok(block.includes('downloadPlaylistNote(audioData)'), 'o ramo download_audio deve mostrar a linha de playlist');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('F. Fila com item de voz (provedor local falso, TTS real com saída falsa)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('o TTS de teste subiu (provedor falso + saída falsa)', () => {
  assert.equal(initResult.enabled, true, JSON.stringify(initResult));
});
await test('voz, caminho feliz: resposta no chat (com a menção), persona de voz no fim, UMA chamada à IA, e o gancho entrega os campos exatos à fala', async () => {
  const before = captured.length;
  const requestedAt = Date.now();
  const msg = fakeVoiceMessage({ userId: '222' });
  await run(msg, 'qual a capital da Austrália', voiceOptions('qual a capital da Austrália', { voiceRequestedAt: requestedAt }), { script: [{ text: 'Canberra, não Sydney.', finish: 'stop' }] });
  assert.equal(localCalls.length, 1, 'uma única chamada à IA');
  const sys = systemOf(lastMessages());
  assert.ok(sys.endsWith(persona.voicePersonaText()), 'o bloco de voz deveria ser o último do prompt');
  const chat = lastText(msg);
  assert.ok(chat.includes('<@222>') && chat.includes('Canberra, não Sydney.'), `texto no chat: ${chat}`);
  assert.equal(captured.length, before + 1, 'o gancho deveria ter pedido a fala');
  const { guildId, job } = captured.at(-1);
  assert.equal(guildId, GUILD);
  assert.equal(job.userId, '222');
  assert.equal(job.requestedAt, requestedAt, 'requestedAt tem de ser o voiceRequestedAt');
  assert.ok(job.count >= 1);
});
await test('gancho: sem transcript (voiceTranscript ausente ou vazio) NADA é falado: a razão é no-transcript', async () => {
  const before = captured.length;
  const noTranscript = skipped()['no-transcript'] || 0;
  await run(fakeVoiceMessage({ userId: '223' }), 'qual a capital da França', { voice: true, disableTools: true, voiceRequestedAt: Date.now() }, { script: [{ text: 'Paris, claro.' }] });
  await run(fakeVoiceMessage({ userId: '223' }), 'qual a capital da Itália', voiceOptions('   ', {}), { script: [{ text: 'Roma, claro.' }] });
  assert.equal(captured.length, before, 'falou sem transcrição');
  assert.equal(skipped()['no-transcript'] || 0, noTranscript + 2, 'as duas deveriam parar em no-transcript');
});
await test('gancho: pedido velho demais (requestedAt de 40 s atrás) é descartado ANTES da IA: nenhuma chamada, nenhuma resposta', async () => {
  const before = captured.length;
  const msg = fakeVoiceMessage({ userId: '224' });
  resetLocal([{ text: 'não deveria ser chamada' }]);
  await llm.addToQueue('pergunta velha', msg, 'mention', voiceOptions('pergunta velha', { voiceRequestedAt: Date.now() - 40_000 }));
  await sleep(1500);
  assert.equal(localCalls.length, 0, 'a IA foi chamada para um pedido velho');
  assert.equal(msg.finals.length, 0, 'respondeu a um pedido velho');
  assert.equal(captured.length, before);
  // a fila não ficou presa: o próximo pedido (novo) é atendido
  const next = fakeVoiceMessage({ userId: '224' });
  await run(next, 'pergunta nova', voiceOptions('pergunta nova'), { script: [{ text: 'Resposta nova.' }] });
  assert.ok(lastText(next).includes('Resposta nova.'));
});
await test('prazo configurável: YUI_TTS_STALE_SECONDS=5 descarta um pedido de 10 s; sem requestedAt nunca é descartado', async () => {
  process.env.YUI_TTS_STALE_SECONDS = '5';
  try {
    const old = fakeVoiceMessage({ userId: '225' });
    resetLocal([{ text: 'x' }]);
    await llm.addToQueue('velho', old, 'mention', voiceOptions('velho', { voiceRequestedAt: Date.now() - 10_000 }));
    await sleep(1500);
    assert.equal(localCalls.length, 0, 'deveria descartar com prazo de 5 s');
  } finally {
    delete process.env.YUI_TTS_STALE_SECONDS;
  }
  const noStamp = fakeVoiceMessage({ userId: '225' });
  await run(noStamp, 'sem carimbo', { voice: true, voiceTranscript: 'sem carimbo', disableTools: true }, { script: [{ text: 'Respondi mesmo sem carimbo.' }] });
  assert.ok(lastText(noStamp).includes('Respondi mesmo sem carimbo.'));
});
await test('um fio de histórico por pessoa: a mesma pessoa continua a conversa; outra pessoa e o canal de texto NÃO veem; clearVoiceHistory apaga', async () => {
  const guild = 'g-hist';
  const a1 = fakeVoiceMessage({ userId: '301', guildId: guild });
  await run(a1, 'meu nome é Ana e gosto de GTA', voiceOptions('meu nome é Ana e gosto de GTA'), { script: [{ text: 'Prazer, Ana.' }] });
  const a2 = fakeVoiceMessage({ userId: '301', guildId: guild });
  await run(a2, 'e qual o meu jogo favorito', voiceOptions('e qual o meu jogo favorito'), { script: [{ text: 'GTA.' }] });
  assert.deepEqual(historyPart(lastMessages()), ['user:meu nome é Ana e gosto de GTA', 'assistant:Prazer, Ana.'], 'a mesma pessoa deveria ver o próprio fio');
  const b1 = fakeVoiceMessage({ userId: '302', guildId: guild });
  await run(b1, 'oi sou o Beto', voiceOptions('oi sou o Beto'), { script: [{ text: 'Oi, Beto.' }] });
  assert.deepEqual(historyPart(lastMessages()), [], 'outra pessoa não pode ver o fio da Ana');
  const t1 = fakeTextMessage({ userId: '301', guildId: guild, channelId: TEXT_CHANNEL });
  await run(t1, '<@999> oi no texto', { allowSearch: false, searchPrompt: 'oi no texto' }, { script: [{ text: 'Oi no texto.' }] });
  assert.deepEqual(historyPart(lastMessages()), [], 'o canal de texto não pode ver a conversa por voz');
  const a3 = fakeVoiceMessage({ userId: '301', guildId: guild });
  await run(a3, 'terceira fala', voiceOptions('terceira fala'), { script: [{ text: 'Ok.' }] });
  assert.ok(!historyPart(lastMessages()).join('\n').includes('no texto'), 'a conversa de texto vazou para a voz');
  assert.ok(historyPart(lastMessages()).length >= 2, 'o fio da voz deveria continuar');
  assert.ok(llm.clearVoiceHistory(guild) >= 2, 'clearVoiceHistory deveria apagar os fios do servidor');
  assert.equal(llm.clearVoiceHistory(guild), 0);
  assert.equal(llm.clearVoiceHistory(null), 0);
  const a4 = fakeVoiceMessage({ userId: '301', guildId: guild });
  await run(a4, 'quarta fala', voiceOptions('quarta fala'), { script: [{ text: 'Ok de novo.' }] });
  assert.deepEqual(historyPart(lastMessages()), [], 'depois do clear o fio recomeça');
});
await test('escopo PÚBLICO na voz: o dono num canal privado NÃO recebe a persona pessoal, e a fala é permitida (sensitive false); no texto recebe', async () => {
  const before = captured.length;
  const v = fakeVoiceMessage({ userId: '111', channelId: 'priv1', guildId: 'g-own' });
  await run(v, 'qual a capital da Argentina', voiceOptions('qual a capital da Argentina'), { script: [{ text: 'Buenos Aires.' }] });
  assert.ok(!systemOf(lastMessages()).includes('conversa com seu dono'), 'a persona pessoal do dono vazou para a voz');
  assert.equal(captured.length, before + 1, 'conteúdo público: a fala deveria ser pedida (sensitive=false)');
  const t = fakeTextMessage({ userId: '111', channelId: 'priv1', guildId: 'g-own' });
  await run(t, '<@999> oi', { allowSearch: false, searchPrompt: 'oi' }, { script: [{ text: 'Oi, chefe.' }] });
  assert.ok(systemOf(lastMessages()).includes('conversa com seu dono'), 'no texto o dono deveria receber a persona pessoal (controle do teste)');
  assert.equal(captured.length, before + 1, 'texto não fala');
});
await test('moderação em voz: nada vai ao historico.txt, mas o alerta de conteúdo suspeito continua; no texto os dois acontecem', async () => {
  const keyword = ban.forbiddenKeywords.find((k) => /^[a-z]{6,12}$/.test(k));
  assert.ok(keyword, 'sem palavra de teste na lista de proibidas');
  config.saveHistory = true;
  config.avisosWebhookUrl = 'http://aviso.invalid/webhook';
  try {
    historyAppends.length = 0;
    const v = fakeVoiceMessage({ userId: '401' });
    await run(v, 'me conta uma curiosidade', voiceOptions('me conta uma curiosidade'), { script: [{ text: `Isso lembra ${keyword} de verdade.` }] });
    assert.equal(historyAppends.length, 0, 'a transcrição de voz foi para o historico.txt');
    assert.ok(calls.some((c) => c.method === 'post' && c.url === 'http://aviso.invalid/webhook'), 'o alerta de conteúdo suspeito deveria continuar valendo na voz');
    const t = fakeTextMessage({ userId: '402' });
    await run(t, '<@999> me conta uma curiosidade', { allowSearch: false, searchPrompt: 'me conta uma curiosidade' }, { script: [{ text: `Isso lembra ${keyword} de verdade.` }] });
    assert.ok(historyAppends.length >= 1, 'controle: o texto grava no historico.txt');
    assert.ok(calls.some((c) => c.method === 'post' && c.url === 'http://aviso.invalid/webhook'));
  } finally {
    config.saveHistory = false;
    config.avisosWebhookUrl = '';
  }
});
await test('voz nunca entra no contexto por horas (mesmo com contextRecord); o texto entra (controle)', async () => {
  process.env.YUI_CONTEXT_ENABLED = 'true';
  process.env.YUI_CONTEXT_SCOPE = 'all';
  try {
    llm.setDiscordClient({ user: { id: '999' } });
    assert.ok(await waitFor(() => fs.existsSync(path.join(tmp, 'memory-context.db')), 10000), 'o contexto deveria abrir os arquivos');
    const turns = () => ctxMod.contextCounts().turns;
    const t0 = turns();
    await run(fakeVoiceMessage({ userId: '501', guildId: 'g-ctx' }), 'primeira de voz', voiceOptions('primeira de voz', { contextRecord: true }), { script: [{ text: 'Ouvi.' }] });
    await run(fakeVoiceMessage({ userId: '501', guildId: 'g-ctx' }), 'segunda de voz', voiceOptions('segunda de voz', { contextRecord: true }), { script: [{ text: 'Ouvi de novo.' }] });
    assert.equal(turns(), t0, 'a voz gravou no contexto por horas');
    const msg = fakeTextMessage({ userId: '501', guildId: 'g-ctx', channelId: 'chan-ctx' });
    await run(msg, '<@999> pergunta de texto', { allowSearch: false, searchPrompt: 'pergunta de texto' }, { script: [{ text: 'Resposta de texto.' }] });
    assert.ok(turns() > t0, 'controle: o texto deveria gravar no contexto (o recurso estava ligado)');
  } finally {
    delete process.env.YUI_CONTEXT_ENABLED;
    delete process.env.YUI_CONTEXT_SCOPE;
  }
});
await test('voz nunca vira memória (a transcrição é fala de terceiros ouvida por todos); o mesmo texto no chat vira (controle)', async () => {
  const { contextFromDiscord, buildMemoryBlock } = await import('../src/core/discordAdapter.js');
  const recallFor = (userId) => buildMemoryBlock(contextFromDiscord({ userId, guildId: 'g-mem', channelId: null }), 'Zezinho');
  await run(fakeVoiceMessage({ userId: '951', guildId: 'g-mem' }), 'meu nome é Zezinho Vozeiro', voiceOptions('meu nome é Zezinho Vozeiro'), { script: [{ text: 'Prazer.' }] });
  assert.ok(!recallFor('951').includes('Zezinho'), 'a transcrição de voz foi gravada na memória');
  await run(fakeTextMessage({ userId: '952', guildId: 'g-mem' }), '<@999> meu nome é Zezinho Textual', { allowSearch: false, searchPrompt: 'meu nome é Zezinho Textual' }, { script: [{ text: 'Prazer.' }] });
  assert.ok(recallFor('952').includes('Zezinho'), 'controle: o texto deveria gravar na memória');
});
await test('texto do chat e mensagem do rádio (isVoice sem options.voice) NUNCA disparam fala', async () => {
  const before = captured.length;
  const radioLike = fakeVoiceMessage({ userId: '601', guildId: 'g-radio' });
  await run(radioLike, 'toca uma música', { allowSearch: false, voiceTranscript: 'toca uma música', voiceRequestedAt: Date.now() }, { script: [{ text: 'Claro, vou tocar.' }] });
  const text = fakeTextMessage({ userId: '601', guildId: 'g-radio' });
  await run(text, '<@999> oi', { allowSearch: false, searchPrompt: 'oi', voiceTranscript: 'oi', voiceRequestedAt: Date.now() }, { script: [{ text: 'Oi.' }] });
  assert.equal(captured.length, before, 'falou sem options.voice');
  assert.ok(!systemOf(lastMessages()).includes('[MODO VOZ]'));
});
await test('texto longo na voz: o chat recebe no máximo 1900 caracteres cortados em fim de frase (sem divisor)', async () => {
  const long = Array.from({ length: 400 }, (_, i) => `Esta é a frase número ${i + 1}.`).join(' ');
  assert.ok(long.length > 5000);
  const msg = fakeVoiceMessage({ userId: '701', guildId: 'g-long' });
  await run(msg, 'conta uma história bem longa', voiceOptions('conta uma história bem longa'), { script: [{ text: long }] });
  const sent = msg.finals.filter((p) => typeof p.content === 'string' && p.content.length > 0);
  assert.equal(sent.length, 1, 'uma mensagem só, sem divisor');
  const body = sent[0].content.replace(/^<@701> /, '');
  assert.ok(body.length <= 1900, `tamanho ${body.length}`);
  assert.ok(body.endsWith('.'), `terminou no meio da frase: ...${body.slice(-30)}`);
  assert.ok(!/Parte \d+ de \d+/.test(body));
  assert.ok(body.startsWith('Esta é a frase número 1.'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('G. Ferramentas por voz: execução barrada (todos os caminhos de despacho)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const TOOL_CASES = [
  ['JSON puro com download_audio', '{"thought":"baixar","tool":"download_audio","args":{"url":"https://youtu.be/dQw4w9WgXcQ"}}'],
  ['JSON com search_web', '{"thought":"buscar","tool":"search_web","args":{"query":"qualquer coisa"}}'],
  ['JSON com join_voice_call', '{"thought":"entrar","tool":"join_voice_call","args":{}}'],
  ['JSON com ia_automod', '{"thought":"banir","tool":"ia_automod","args":{"reason":"x","severity":"alta"}}'],
  ['formato [Tool Use: ...]', '[Tool Use: download_audio args={"url":"https://youtu.be/dQw4w9WgXcQ"}]'],
  ['JSON no meio de um texto', 'Claro, já faço isso! {"thought":"baixar","tool":"download_video","args":{"url":"https://youtu.be/dQw4w9WgXcQ"}}'],
  ['chave "name" no lugar de "tool"', '{"name":"download_audio","args":{"url":"https://youtu.be/dQw4w9WgXcQ"}}'],
];
for (const [label, raw] of TOOL_CASES) {
  await test(`voz: ${label} NÃO executa, não é falado e a resposta é o texto fixo`, async () => {
    const before = captured.length;
    const msg = fakeVoiceMessage({ userId: '801', guildId: 'g-tools' });
    await run(msg, 'baixa esse áudio pra mim', voiceOptions('baixa esse áudio pra mim'), { script: [{ text: raw }] });
    const chat = lastText(msg);
    assert.ok(chat.includes(VOICE_REFUSAL), `resposta no chat: ${chat}`);
    assert.ok(!chat.includes('{') && !/tool|default_api/i.test(chat), 'o JSON da ferramenta apareceu');
    assert.ok(!hasEmbed(msg), 'um embed de execução apareceu');
    assert.deepEqual(calls.filter((c) => c.url !== config.localLlmUrl).map((c) => c.url), [], 'a ferramenta chegou a falar com a rede');
    assert.equal(captured.length, before + 1, 'a recusa em texto fixo é falada');
  });
}
await test('voz: chamada em texto "print(default_api.download_audio(...))" nunca executa nada (o texto de ferramenta é removido antes e não vira fala nem embed)', async () => {
  const msg = fakeVoiceMessage({ userId: '809', guildId: 'g-tools' });
  await run(msg, 'baixa esse áudio pra mim', voiceOptions('baixa esse áudio pra mim'), { script: [{ text: 'print(default_api.download_audio(url="https://youtu.be/dQw4w9WgXcQ"))' }] });
  assert.ok(!hasEmbed(msg), 'um embed de execução apareceu');
  assert.ok(!/default_api|download_audio/.test(lastText(msg)), `o texto da ferramenta apareceu: ${lastText(msg)}`);
  // (sem resposta aproveitável o texto cai nos provedores seguintes; o que importa é que o link nunca é baixado)
  assert.ok(!calls.some((c) => /youtu/i.test(c.url) || /youtu/i.test(JSON.stringify(c.body ?? {}))), 'o link da ferramenta chegou à rede');
});
await test('voz: a recusa fixa repetida em seguida continua sendo a MESMA frase (não regenera pela IA)', async () => {
  const raw = '{"thought":"baixar","tool":"download_audio","args":{"url":"https://youtu.be/dQw4w9WgXcQ"}}';
  const first = fakeVoiceMessage({ userId: '810', guildId: 'g-tools' });
  await run(first, 'baixa esse áudio pra mim', voiceOptions('baixa esse áudio pra mim'), { script: [{ text: raw }] });
  const second = fakeVoiceMessage({ userId: '810', guildId: 'g-tools' });
  await run(second, 'baixa de novo', voiceOptions('baixa de novo'), { script: [{ text: raw }] });
  assert.ok(lastText(first).includes(VOICE_REFUSAL) && lastText(second).includes(VOICE_REFUSAL), lastText(second));
  assert.equal(localCalls.length, 1, 'a segunda recusa não deveria gastar outra chamada à IA');
});
await test('voz com a oferta de ferramentas já fechada (disableTools ausente): a recusa continua sendo a do texto fixo', async () => {
  const msg = fakeVoiceMessage({ userId: '802', guildId: 'g-tools' });
  await run(msg, 'abre o menu', { voice: true, voiceTranscript: 'abre o menu', voiceRequestedAt: Date.now() }, { script: [{ text: '{"thought":"menu","tool":"show_bot_menu","args":{"context":"geral"}}' }] });
  assert.ok(lastText(msg).includes(VOICE_REFUSAL));
  assert.ok(!hasEmbed(msg));
});
await test('voz: o atalho "baixa a música do meu status" (sem ferramenta, só pela frase) também não roda; a resposta é o texto fixo', async () => {
  const msg = fakeVoiceMessage({ userId: '803', guildId: 'g-tools' });
  await run(msg, 'baixa a música do meu status', voiceOptions('baixa a música do meu status'), { script: [{ text: 'Posso tentar baixar.' }] });
  assert.ok(lastText(msg).includes(VOICE_REFUSAL), lastText(msg));
  assert.ok(!hasEmbed(msg));
});
await test('voz: generate_reply (só o texto da resposta) NÃO é bloqueado', async () => {
  const msg = fakeVoiceMessage({ userId: '804', guildId: 'g-tools' });
  await run(msg, 'oi tudo bem', voiceOptions('oi tudo bem'), { script: [{ text: '{"thought":"conversa","tool":"generate_reply","args":{"content":"Tudo certo por aqui."}}' }] });
  const chat = lastText(msg);
  assert.ok(chat.includes('Tudo certo por aqui.'), chat);
  assert.ok(!chat.includes(VOICE_REFUSAL));
});
await test('YUI_VOICE_TOOLS=true devolve o comportamento antigo: a ferramenta show_bot_menu executa por voz', async () => {
  process.env.YUI_VOICE_TOOLS = 'true';
  try {
    const msg = fakeVoiceMessage({ userId: '805', guildId: 'g-tools2' });
    await run(msg, 'abre o menu de ajuda', voiceOptions('abre o menu de ajuda', { disableTools: false }), { until: hasEmbed, script: [{ text: '{"thought":"menu","tool":"show_bot_menu","args":{"context":"geral"}}' }] });
    assert.ok(hasEmbed(msg), 'o menu deveria ser enviado (ferramentas liberadas)');
    assert.ok(!msg.finals.some((p) => String(p.content ?? '').includes(VOICE_REFUSAL)));
  } finally {
    delete process.env.YUI_VOICE_TOOLS;
  }
});
await test('texto (não voz): o JSON de ferramenta continua executando como antes', async () => {
  const msg = fakeTextMessage({ userId: '806', guildId: 'g-tools3' });
  await run(msg, '<@999> abre o menu de ajuda', { allowSearch: false, searchPrompt: 'abre o menu de ajuda' }, { until: hasEmbed, script: [{ text: '{"thought":"menu","tool":"show_bot_menu","args":{"context":"geral"}}' }] });
  assert.ok(hasEmbed(msg), 'no texto o menu deveria abrir');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('H. check_game_info: o ramo de erro entrega a mensagem');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('jogo sem dados: o usuário recebe uma mensagem amigável (a da IA), sem texto técnico, e não só o embed "Executando Ação"', async () => {
  const msg = fakeTextMessage({ userId: '901', guildId: 'g-game' });
  const answer = 'Não achei infos completas desse jogo, tenta outra fonte.';
  await run(msg, '<@999> qual a nota do jogo Zzzxxyy Inexistente', { allowSearch: false, searchPrompt: 'qual a nota do jogo Zzzxxyy Inexistente' }, {
    responder: (body) => (JSON.stringify(body.messages.at(-1)).includes('perguntou sobre o jogo')
      ? { text: answer }
      : (/Otimizador/i.test(JSON.stringify(body.messages)) ? { text: 'nota jogo' } : { text: '{"thought":"info do jogo","tool":"check_game_info","args":{"game":"Zzzxxyy Inexistente"}}' })),
  });
  const chat = lastText(msg);
  assert.ok(chat.includes(answer), `mensagem entregue: ${JSON.stringify(chat)}`);
  assert.ok(!/ECONN|status code|axios|Error:/i.test(chat), 'texto técnico no chat');
  const last = msg.finals.at(-1);
  assert.ok(!last.embeds || last.embeds.length === 0, 'o embed de execução deveria ter sido trocado pela mensagem');
});
await test('jogo sem dados e a IA também falha: sai a frase do gameInfoHandler ou a fixa (nunca o erro do provedor)', async () => {
  const msg = fakeTextMessage({ userId: '902', guildId: 'g-game' });
  // 1ª resposta: a chamada de ferramenta; a 2ª (fallback da IA) e as seguintes vêm do falso como erro de sistema
  await run(msg, '<@999> requisitos do jogo Qqqwwweee Inexistente', { allowSearch: false, searchPrompt: 'qual a nota do jogo Qqqwwweee Inexistente' }, {
    responder: (body) => (JSON.stringify(body.messages.at(-1)).includes('perguntou sobre o jogo')
      ? { text: '⚠️ SYSTEM ERROR: provedor caiu' }
      : (/Otimizador/i.test(JSON.stringify(body.messages)) ? { text: 'nota jogo' } : { text: '{"thought":"info do jogo","tool":"check_game_info","args":{"game":"Qqqwwweee Inexistente"}}' })),
  });
  const chat = lastText(msg);
  assert.ok(chat.length > 10 && !chat.includes('SYSTEM ERROR'), chat);
  assert.ok(/Qqqwwweee Inexistente|Não consegui|nenhuma fonte/i.test(chat), chat);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('I. sttService: a chave do Gemini vai no cabeçalho, nunca na URL');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('Gemini STT: x-goog-api-key no header; a URL (e o corpo) não contêm a chave nem "key="', async () => {
  const key = 'AIzaSyFAKE-chave-de-teste-0123456789';
  process.env.GEMINI_API_KEY = key;
  try {
    const stt = await import('../src/services/sttService.js');
    resetLocal();
    postHook = (url, body, cfg) => {
      if (!url.includes('generativelanguage.googleapis.com')) return undefined;
      return { data: { candidates: [{ content: { parts: [{ text: ' yui qual a capital da Austrália ' }] } }] } };
    };
    const text = await stt.transcribeAudio(Buffer.from('RIFF-fake-wav'), 'fala.wav');
    assert.equal(text, 'yui qual a capital da Austrália');
    const call = calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
    assert.ok(call, 'o Gemini deveria ter sido chamado');
    assert.ok(!call.url.includes('key='), `a URL tem key=: ${call.url}`);
    assert.ok(!call.url.includes(key), 'a URL tem a chave');
    assert.equal(call.config.headers['x-goog-api-key'], key);
    assert.equal(call.config.headers['Content-Type'], 'application/json');
    assert.ok(!JSON.stringify(call.body).includes(key), 'o corpo tem a chave');
    assert.ok(/:generateContent$/.test(call.url), call.url);
  } finally {
    delete process.env.GEMINI_API_KEY;
    postHook = localLlmHook;
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('J. Requisitos nas fontes');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const src = read('src/handlers/llmHandler.js').replace(/\r\n/g, '\n');
await test('fontes: o gancho [TTS-HOOK] vem DEPOIS da entrega e ANTES do histórico; campos exatos; sem await; só para item de voz', () => {
  const deliver = src.indexOf('await unifiedReply(processedResponse);');
  const hook = src.indexOf('// [TTS-HOOK]');
  const history = src.indexOf('recordMainExchange(processedResponse, delivery, { webSearchUsed, genMeta });');
  assert.ok(deliver > 0 && hook > deliver && history > hook, 'ordem entrega -> gancho -> histórico');
  const block = src.slice(hook, history);
  assert.ok(/if \(voiceSpeak && delivery\.ok && sentMessage\)/.test(block), 'o gancho precisa da entrega confirmada e de item de voz FALADO');
  assert.ok(/const voiceSpeak = isVoice && options\.voiceSpeak !== false;/.test(src), 'voiceSpeak só se o item de voz não pediu silêncio');
  assert.ok(/speakVoiceReply\(\{ guildId, userId, text: processedResponse, transcript: options\.voiceTranscript, sensitive: coreCtx\.memoryScope === 'personal', requestedAt: options\.voiceRequestedAt, fromVoice: true \}\)/.test(block), 'campos do gancho');
  assert.ok(!/await speakVoiceReply/.test(src), 'o gancho não pode esperar a fala');
  assert.ok(/\} catch \(_\) \{/.test(block), 'o gancho precisa de try/catch');
  assert.equal((src.match(/speakVoiceReply\(/g) || []).length, 1, 'um único ponto de fala');
});
await test('fontes: ban e AutoMod usam o canal de texto REAL; histórico/persona/escopo usam a chave de voz; contexto de voz é público', () => {
  assert.ok(/channelId: realChannelId, options \}\) \{/.test(src), 'o parâmetro channelId vira realChannelId');
  assert.ok(/const channelId = isVoice \? buildVoiceKey\(guildId, userId\) : realChannelId;/.test(src));
  assert.ok(/checkAutoBan\(triggerSource, guildName, guildId, channelName, realChannelId, userId\)/.test(src));
  assert.ok(/checkBan\(userId, guildId, realChannelId\)/.test(src));
  assert.ok(/autoBanTrigger\.type === 'channel' \? realChannelId : null/.test(src));
  assert.ok(/channelId: isVoice \? null : channelId,/.test(src), 'contextFromDiscord precisa de channelId null na voz');
  assert.ok(/if \(options\?\.voice === true\) return null;/.test(src), 'contextTargetFor precisa recusar voz');
  assert.ok(!/contextKey/.test(src), 'a chave do contexto não pode viajar nas opções');
});
await test('fontes: o despacho de ferramenta passa pelo guarda de voz ANTES de executar e o isVoiceItem/stale usam voiceGuards', () => {
  const guard = src.indexOf('voiceToolBlocked(toolData.tool, options)');
  const dispatch = src.indexOf('if (toolData.tool && toolData.args) {');
  const disabledCheck = src.indexOf("options.disableTools === true && toolData.tool && toolData.tool !== 'generate_reply'");
  assert.ok(guard > 0 && dispatch > guard, 'o guarda precisa vir antes do despacho');
  assert.ok(disabledCheck > guard, 'a recusa de voz precisa vir antes da checagem de disableTools');
  assert.ok(/processedResponse = VOICE_TOOL_REFUSAL;/.test(src));
  assert.ok(/isVoiceItem\(options, interaction\)/.test(src));
  assert.ok(/isStaleVoiceItem\(processingQueue\[0\]\?\.options/.test(src));
  assert.ok(/clipForChat\(processedResponse, 1900\)/.test(src));
  assert.ok(/applyVoicePersona\(baseSystemPrompt\)/.test(src));
  // Voz: só a moderação (nada no historico.txt). O wrapper da rodada final (texto de anexo fora do disco) chama sempre a função base.
  assert.ok(/const savePromptToHistoryBase = isVoice \? moderateVoiceExchange : savePromptToHistoryOnDisk;/.test(src));
  assert.ok(/const savePromptToHistory = \(promptToSave, \.\.\.rest\) => savePromptToHistoryBase\(/.test(src));
  assert.ok(/const captureText = isVoice \? null :/.test(src), 'a voz nunca vira memória');
});
await test('fontes: llmHandler não importa voiceHandler de volta pelo serviço de TTS (sem ciclo novo) e o serviço não importa o llmHandler', () => {
  for (const f of ['index', 'output', 'engine', 'policy', 'voiceGuards', 'config']) {
    const code = read(`src/services/tts/${f}.js`);
    assert.ok(!/from '[^']*llmHandler/.test(code), `${f}.js importa o llmHandler`);
    assert.ok(!/from '[^']*voiceHandler/.test(code), `${f}.js importa o voiceHandler`);
  }
  assert.ok(/import \{ interruptSpeech, speakVoiceReply \} from '\.\.\/services\/tts\/index\.js';/.test(src));
});
await test('fontes: sem console.* com texto de voz nas linhas novas (o raciocínio da ferramenta em voz vai por logger, só com tamanho)', () => {
  const i = src.indexOf('if (isVoice) {\n                        // Voz: o raciocínio');
  assert.ok(i > 0);
  const block = src.slice(i, i + 700);
  assert.ok(/logger\.info\(`\[MCP TOOL\] Detectado:/.test(block));
  assert.ok(/raciocínio de \$\{String\(toolData\.thought \?\? ''\)\.length\} caracteres/.test(block));
});
await test('fontes: mcp_tools.json válido, JSON sem BOM e fim de linha CRLF preservado nos arquivos CRLF', () => {
  for (const rel of ['src/handlers/llmHandler.js', 'src/handlers/mcpToolPanelHandler.js', 'src/data/mcp_tools.json']) {
    const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.equal((raw.match(/(?<!\r)\n/g) || []).length, 0, `${rel} tem LF solto`);
    assert.ok(!raw.startsWith('\uFEFF'));
  }
  const persona = fs.readFileSync(path.join(repoRoot, 'src/core/persona.js'), 'utf8');
  assert.equal((persona.match(/\r/g) || []).length, 0, 'persona.js é LF');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('K. Correções da revisão final (pedido de voz que não fala, AutoMod, saída da call, aviso de pedido vencido)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const requestsNow = () => tts.getTtsStatus().counters.requests;

await test('voz SEM fala (palavra de ativação no meio da frase, voiceSpeak=false): continua sendo voz, mas não fala e não usa a persona curta', async () => {
  const before = captured.length;
  const reqBefore = requestsNow();
  const msg = fakeVoiceMessage({ userId: '1001', guildId: 'g-nospeak' });
  await run(msg, 'que horas são', voiceOptions('que horas são', { voiceSpeak: false }), { script: [{ text: 'São três e meia, com um monte de detalhes extras para o chat.', finish: 'stop' }] });
  assert.ok(lastText(msg).includes('<@1001>') && lastText(msg).includes('São três e meia'), 'o texto vai ao chat');
  assert.equal(captured.length, before, 'não pediu fala');
  assert.equal(requestsNow(), reqBefore, 'nem chegou a chamar o serviço de fala');
  const sys = systemOf(lastMessages());
  assert.ok(!sys.includes('[MODO VOZ]'), 'resposta só em texto: sem a persona curta de fala');
  assert.ok(!sys.includes('FERRAMENTAS DISPONÍVEIS'), 'e sem a oferta de ferramentas');
  // controle: com voiceSpeak ausente (o padrão do modo voz falável) a persona entra e a fala é pedida
  const spoken = fakeVoiceMessage({ userId: '1002', guildId: 'g-nospeak' });
  await run(spoken, 'que horas são', voiceOptions('que horas são'), { script: [{ text: 'São três e meia.', finish: 'stop' }] });
  assert.ok(systemOf(lastMessages()).endsWith(persona.voicePersonaText()));
  assert.equal(captured.length, before + 1);
});
await test('voz SEM fala: ferramenta devolvida pela IA NÃO executa (recusa fixa, sem embed nem rede) e a recusa não é falada', async () => {
  const before = captured.length;
  const msg = fakeVoiceMessage({ userId: '1003', guildId: 'g-nospeak' });
  await run(msg, 'baixa o áudio', voiceOptions('baixa o áudio', { voiceSpeak: false }), { script: [{ text: '{"thought":"baixar","tool":"download_audio","args":{"url":"https://youtu.be/dQw4w9WgXcQ"}}' }] });
  assert.ok(lastText(msg).includes(VOICE_REFUSAL), lastText(msg));
  assert.ok(!hasEmbed(msg));
  assert.deepEqual(calls.filter((c) => c.url !== config.localLlmUrl).map((c) => c.url), []);
  assert.equal(captured.length, before, 'sem fala');
});
await test('voz SEM fala: nada vai ao historico.txt, nada vira memória e o contexto por horas não grava (igual à voz falada)', async () => {
  const { contextFromDiscord, buildMemoryBlock } = await import('../src/core/discordAdapter.js');
  config.saveHistory = true;
  try {
    historyAppends.length = 0;
    const msg = fakeVoiceMessage({ userId: '1004', guildId: 'g-mem2' });
    await run(msg, 'meu nome é Zezinho Mudinho', voiceOptions('meu nome é Zezinho Mudinho', { voiceSpeak: false }), { script: [{ text: 'Prazer.' }] });
    assert.equal(historyAppends.length, 0, 'a transcrição foi para o historico.txt');
    assert.ok(!buildMemoryBlock(contextFromDiscord({ userId: '1004', guildId: 'g-mem2', channelId: null }), 'Zezinho').includes('Zezinho'), 'virou memória');
  } finally {
    config.saveHistory = false;
  }
});

await test('AutoMod por gatilho em VOZ só alerta o dono (webhook): não bane o falante por uma palavra mal transcrita; no texto continua banindo', async () => {
  const guild = 'g-automod';
  assert.ok(['both', 'trigger'].includes(ban.getAutoBlockMode(guild)), `o teste precisa do AutoMod por gatilho ligado: ${ban.getAutoBlockMode(guild)}`);
  config.avisosWebhookUrl = 'http://aviso.invalid/webhook';
  const phrase = 'como funciona a tortura naquele filme de terror';
  try {
    calls.length = 0;
    const v = fakeVoiceMessage({ userId: '4242', guildId: guild });
    await run(v, phrase, voiceOptions(phrase), { script: [{ text: 'É só efeito especial.' }] });
    assert.equal(ban.checkBan('4242', guild, null), null, 'a voz baniu o falante');
    assert.ok(!hasEmbed(v), 'o aviso de banimento apareceu na voz');
    assert.ok(lastText(v).includes('É só efeito especial.'), 'o pedido continua sendo respondido');
    assert.ok(calls.some((c) => c.method === 'post' && c.url === 'http://aviso.invalid/webhook'), 'o dono deveria receber o alerta (com os botões de banir/ignorar)');
    // a mesma coisa sem fala (palavra de ativação no meio da frase) também só alerta
    const v2 = fakeVoiceMessage({ userId: '4244', guildId: guild });
    await run(v2, phrase, voiceOptions(phrase, { voiceSpeak: false }), { script: [{ text: 'Cinema, só cinema.' }] });
    assert.equal(ban.checkBan('4244', guild, null), null);
    // controle: no texto o gatilho segue banindo
    const t = fakeTextMessage({ userId: '4243', guildId: guild, channelId: 'chan-automod' });
    const textReplies = [];
    t.reply = async (p) => { textReplies.push(p); return { id: 'ban-notice', channel: t.channel, edit: async () => ({}) }; };
    await run(t, '<@999> ' + phrase, { allowSearch: false, searchPrompt: phrase }, { until: () => textReplies.some((p) => (p.embeds || []).length > 0), script: [{ text: 'Não deveria responder.' }] });
    assert.ok(ban.checkBan('4243', guild, null), 'controle: o texto deveria banir');
    assert.ok(interceptedBanWrites.length >= 1, 'o ban do controle foi gravado no arquivo interceptado (nunca no real)');
  } finally {
    config.avisosWebhookUrl = '';
    ban.removeBan('user', '4243');
    ban.removeBan('user', '4242');
    ban.removeBan('user', '4244');
  }
});

await test('sair da call pelo ramo generate_reply: respeita o interruptor de leave_voice_call e a regra da voz (antes saía mesmo com a ferramenta desligada)', () => toolsSandbox(async () => {
  const guild = 'g-sw-1';
  const reply = (n) => `Claro, até a próxima! {"thought":"conversa","tool":"generate_reply","args":{"content":"Tchau número ${n}, até logo!"}}`;
  const NOT_IN_CALL = 'Não estou em nenhum canal de voz'; // o que o leaveVoiceCall diz neste teste (não há conexão real)
  const textMessage = (userId) => {
    const m = fakeTextMessage({ userId, guildId: guild });
    m.sends = [];
    m.channel.send = async (p) => { m.sends.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: 'sent' }; };
    return m;
  };
  const left = (m) => m.sends.some((s) => s.includes(NOT_IN_CALL));
  assert.equal(llm.isToolDisabled(guild, 'leave_voice_call'), true, 'padrão: sair da call está desligado');
  const off = textMessage('5001');
  await run(off, '<@999> yui sai da call', { allowSearch: false, searchPrompt: 'yui sai da call' }, { script: [{ text: reply(1) }] });
  assert.ok(lastText(off).includes('Tchau número 1'), 'a resposta de texto continua saindo');
  assert.equal(left(off), false, 'ferramenta desligada: não pode sair da call');

  llm.setServerToolEnabled(guild, 'leave_voice_call', true);
  const on = textMessage('5002');
  await run(on, '<@999> yui sai da call', { allowSearch: false, searchPrompt: 'yui sai da call' }, { script: [{ text: reply(2) }] });
  assert.equal(left(on), true, 'controle: com a ferramenta ligada o ramo continua funcionando');

  // voz (ferramentas por voz desligadas), mesmo com a ferramenta ligada no servidor: não sai
  const voiceMsg = fakeVoiceMessage({ userId: '5003', guildId: guild });
  voiceMsg.sends = [];
  voiceMsg.channel.send = async (p) => { voiceMsg.sends.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: 'sent' }; };
  await run(voiceMsg, 'yui sai da call', voiceOptions('yui sai da call'), { script: [{ text: reply(3) }] });
  assert.ok(lastText(voiceMsg).includes('Tchau número 3'));
  assert.equal(left(voiceMsg), false, 'voz sem ferramentas não sai da call pelo texto da transcrição');
}));

await test('pedido de voz vencido na fila da IA: descartado antes da IA, mas a pessoa recebe um aviso curto (e o fio da fila segue)', async () => {
  const msg = fakeVoiceMessage({ userId: '1101', guildId: 'g-stale' });
  const replies = [];
  msg.reply = async (p) => { replies.push(typeof p === 'string' ? p : p?.content ?? ''); return { id: 'x', delete: async () => {} }; };
  resetLocal([{ text: 'não deveria ser chamada' }]);
  await llm.addToQueue('pergunta velha', msg, 'mention', voiceOptions('pergunta velha', { voiceRequestedAt: Date.now() - 40_000 }));
  assert.ok(await waitFor(() => replies.some((r) => /Demorei demais/.test(r)), 15000), `faltou o aviso: ${JSON.stringify(replies)}`);
  assert.equal(localCalls.length, 0, 'a IA foi chamada para um pedido velho');
  assert.equal(replies.filter((r) => /Demorei demais/.test(r)).length, 1, 'um aviso só');
  assert.equal(msg.finals.length, 0);
  const next = fakeVoiceMessage({ userId: '1101', guildId: 'g-stale' });
  await run(next, 'pergunta nova', voiceOptions('pergunta nova'), { script: [{ text: 'Resposta nova.' }] });
  assert.ok(lastText(next).includes('Resposta nova.'));
  // um aviso com defeito (reply que lança) nunca derruba a fila
  const broken = fakeVoiceMessage({ userId: '1102', guildId: 'g-stale' });
  broken.reply = async () => { throw new Error('canal sumiu'); };
  await llm.addToQueue('outra velha', broken, 'mention', voiceOptions('outra velha', { voiceRequestedAt: Date.now() - 40_000 }));
  const after = fakeVoiceMessage({ userId: '1103', guildId: 'g-stale' });
  await run(after, 'depois do defeito', voiceOptions('depois do defeito'), { script: [{ text: 'Segui em frente.' }] });
  assert.ok(lastText(after).includes('Segui em frente.'));
});

await test('downloads por ferramenta (áudio de status, música, vídeo): o erro mostrado ao usuário vem de getMediaUserMessage, nunca do texto cru do erro', () => {
  const src = read('src/handlers/llmHandler.js');
  assert.ok(!/Erro ao (baixar|processar) (a música|o vídeo): \$\{/.test(src), 'sobrou mensagem crua de erro de download');
  for (const fallback of ['Não consegui baixar a música agora', 'Não consegui processar a música agora', 'Não consegui baixar o vídeo agora']) {
    assert.ok(src.includes(fallback), `faltou o texto amigável: ${fallback}`);
  }
  assert.equal((src.match(/getMediaUserMessage\(/g) || []).length >= 5, true, 'o download_audio e as quatro rotas usam o helper');
});

await test('fontes: AutoMod em voz só alerta (condição !isVoice no ban) e a persona de voz só entra quando a resposta é falada', () => {
  const src = read('src/handlers/llmHandler.js');
  assert.ok(/if \(isAutoBlockOn && guildId && !isVoice\) \{/.test(src), 'o ban automático precisa excluir a voz');
  assert.ok(/options\.voice === true && options\.voiceSpeak !== false\) \{\s+baseSystemPrompt = applyVoicePersona/.test(src), 'persona de voz só com voiceSpeak');
  assert.equal((src.match(/voice: voiceSpeak/g) || []).length, 3, 'as chamadas extras à IA seguem o mesmo critério');
  assert.ok(!/voice: isVoice \}/.test(src), 'sobrou chamada extra que força a persona de voz');
  assert.ok(/isToolDisabled\(interaction\.guildId, 'leave_voice_call'\) && !voiceToolBlocked\('leave_voice_call', options\)/.test(src), 'sair da call pelo generate_reply precisa respeitar o interruptor');
});

// ── Resultado ───────────────────────────────────────────────────────────────────────────────────
await tts.shutdownTts();
fs.writeFileSync = realWriteFileSync;
fs.appendFile = realAppendFile;
say(`\n${passed} teste(s) ok, ${failures.length} falha(s).`);
if (failures.length) say(`Falharam: ${failures.join(' | ')}`);
process.chdir(repoRoot);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* pode estar em uso (logs) */ }
process.exit(failures.length ? 1 : 0);
