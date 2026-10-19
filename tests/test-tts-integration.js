// Testes de INTEGRAÇÃO do TTS no bot (a Yui respondendo falando na call), sem Discord, sem rede e sem os bancos reais.
//
// Cobre as costuras entre os módulos de src/services/tts/ e o resto do bot:
//   - bootstrap: o initTts está no arquivo que o boot realmente executa (discord/client.js), não em events/ready.js;
//   - o interruptor `voice_tts` (mcp_tools.json), que a IA nunca vê, e a persona de voz;
//   - regras puras da voz (voiceGuards) e do voiceHandler (comandos, mensagem falsa, debounce, opções do addToQueue);
//   - o fluxo de processVoiceTranscription / handleCapturedAudio / setupVoiceReceiver com dublês;
//   - as dependências do TTS (createTtsDeps) ligadas ao initTts de verdade: nenhuma falha abre a fala;
//   - o despacho de ferramenta bloqueado para voz e o gancho de fala do llmHandler;
//   - o Modo Rádio nunca fala; nada do TTS antigo sobrou; importar services/tts/* não deixa handle aberto.
//
// Roda numa pasta temporária (DATABASE_DIR e cwd), com rede bloqueada. Nada de Discord, STT ou PowerShell de verdade.
// Execução: node tests/test-tts-integration.js
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const file = (rel) => path.join(repoRoot, rel);
const fileUrl = (rel) => pathToFileURL(file(rel)).href;
const source = (rel) => fs.readFileSync(file(rel), 'utf8').replace(/\r\n/g, '\n');

// ── Ambiente isolado ────────────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ttsint-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_OWNER_ID: '111',
  YUI_PRIVATE_CHANNEL_IDS: 'priv1',
  YUI_MEMORY_ENABLED: 'false',
  YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error',
});
for (const k of ['YUI_VOICE_TOOLS', 'YUI_TTS_ENABLED', 'YUI_TTS_PROVIDERS', 'YUI_TTS_CLOUD', 'YUI_PERSONA_VOICE_FILE', 'GEMINI_API_KEY', 'GEMINI_API_KEYS',
  'GROQ_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL']) {
  delete process.env[k];
}
process.chdir(tmp); // logs/, secrets/ e .env ficam no temporário

// Nada sai da máquina.
globalThis.fetch = async () => { throw new Error('rede bloqueada no teste'); };
net.Socket.prototype.connect = function blocked() { throw new Error('rede bloqueada no teste'); };
dns.promises.lookup = async () => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; throw e; };
dns.lookup = (host, opts, cb) => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e); };

// ── Mini-runner ─────────────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(`uncaughtException: ${e?.code || e?.name || e}`));
process.on('unhandledRejection', (e) => escaped.push(`unhandledRejection: ${e?.code || e?.name || e}`));

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`  FALHA  ${name}\n      ${err?.stack || err}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const tick = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// ── Módulos sob teste ───────────────────────────────────────────────────────────────────────────
const voice = await import(fileUrl('src/handlers/voiceHandler.js'));
const llm = await import(fileUrl('src/handlers/llmHandler.js'));
const tts = await import(fileUrl('src/services/tts/index.js'));
const guards = await import(fileUrl('src/services/tts/voiceGuards.js'));
const persona = await import(fileUrl('src/core/persona.js'));
const { contextFromDiscord } = await import(fileUrl('src/core/discordAdapter.js'));
const { createFakeProvider } = await import(fileUrl('src/services/tts/providers/fake.js'));
const { forbiddenKeywords } = await import(fileUrl('src/handlers/banHandler.js'));
const statusCmd = await import(fileUrl('src/discord/commands/status.js'));
const integrations = await import(fileUrl('src/core/api/integrations.js'));
const { PermissionFlagsBits, ChannelType } = await import('discord.js');

// ── Dublês de Discord ───────────────────────────────────────────────────────────────────────────

/** Um "mundo" de Discord em memória: tudo que as deps consultam é lido na hora (mude `w` para mudar o mundo). */
function makeWorld() {
  const w = {
    switchOn: true, tools: null, radio: false, banned: new Set(), opus: true, canSpeak: true, serverMute: false, suppress: false,
    userChannel: 'vc1', meChannel: 'vc1', status: 'ready', leaving: false, banArgs: [], channelType: ChannelType.GuildVoice,
  };
  const mk = (id, bot) => ({
    id,
    displayName: `Nome ${id}`,
    user: { id, bot, username: `user_${id}`, tag: `user_${id}#0`, globalName: null },
    voice: { get channelId() { return w.userChannel; }, selfMute: false, serverMute: false },
  });
  const members = new Map();
  for (let i = 1; i <= 40; i += 1) members.set('u' + i, mk('u' + i, false));
  members.set('b1', mk('b1', true));
  members.set('weird', { id: 'weird', user: { id: 'weird', bot: undefined }, voice: { channelId: 'vc1' } });

  const voiceChannel = {
    id: 'vc1',
    get type() { return w.channelType; },
    members,
    permissionsFor: () => ({ has: (bit) => w.canSpeak && bit === PermissionFlagsBits.Speak }),
  };
  const sent = [];
  const textChannel = {
    id: 'tc1',
    name: 'geral',
    type: ChannelType.GuildText,
    guild: null,
    send: async (payload) => { sent.push(typeof payload === 'string' ? payload : payload?.content); return { id: `msg${sent.length}` }; },
  };
  const guild = {
    id: 'g1',
    members: {
      cache: members,
      me: { voice: { get channelId() { return w.meChannel; }, get serverMute() { return w.serverMute; }, get suppress() { return w.suppress; } } },
    },
    channels: { cache: new Map([['vc1', voiceChannel], ['tc1', textChannel]]) },
    roles: { cache: new Map([['r1', { name: 'Moderadores' }]]) },
  };
  textChannel.guild = guild;
  const client = {
    guilds: { cache: new Map([['g1', guild]]) },
    channels: { cache: new Map([['vc1', voiceChannel], ['tc1', textChannel]]) },
  };
  const connection = { state: { get status() { return w.status; } }, joinConfig: { channelId: 'vc1' } };
  const state = {
    guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1', connection,
    get isLeaving() { return w.leaving; },
  };
  const io = {
    isToolDisabled: (g, name) => (name === 'voice_tts' ? !w.switchOn : true),
    getAllMcpTools: () => w.tools ?? [{ function: { name: 'voice_tts' } }],
    checkBan: (u, g, c) => { w.banArgs.push([u, g, c]); return w.banned.has(u) ? { type: 'user', typeName: 'Usuário' } : null; },
    hasActiveSession: () => w.radio,
    forbiddenKeywords: ['nsfw', 'porn'],
    isOpusAvailable: () => w.opus,
    getActiveState: (g) => (g === 'g1' ? state : undefined),
    getConnection: (g) => (g === 'g1' ? connection : undefined),
  };
  return { w, client, guild, voiceChannel, textChannel, sent, state, connection, io, members };
}

/** Gerenciador de saída falso: só registra o que o serviço mandou. */
function makeFakeManager() {
  const m = {
    enqueued: [], interrupts: [], disposed: [], noted: [], windows: [],
    enqueue(guildId, job) { m.enqueued.push({ guildId, job }); return { ok: true, position: 1 }; },
    interrupt(guildId, reason) { m.interrupts.push([guildId, reason]); return true; },
    dispose(guildId, reason) { m.disposed.push([guildId, reason]); return true; },
    disposeAll() { return 0; },
    isSpeaking() { return false; },
    overlapsSpeech(guildId, a, b) { return m.windows.some((win) => a <= win.end && b >= win.start); },
    noteHumanSpeaking(guildId, userId, speaking) { m.noted.push([guildId, userId, speaking]); },
    warmup: async () => true,
    getStatus: () => ({ count: 0, guilds: [] }),
  };
  return m;
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Sobe o serviço de TTS de verdade (provedor falso + gerenciador falso) com as deps reais do voiceHandler. */
async function startTts(world, { manager = makeFakeManager(), deps = null } = {}) {
  await tts.shutdownTts();
  const realDeps = deps || voice.createTtsDeps(world.client, world.io);
  const result = await tts.initTts({
    client: world.client,
    deps: realDeps,
    overrides: { providers: [createFakeProvider({ name: 'fake' })], manager, logger: silentLogger },
  });
  assert.equal(result.enabled, true, `initTts não ligou: ${JSON.stringify(result)}`);
  return { manager, deps: realDeps };
}

const req = (extra = {}) => ({
  guildId: 'g1', userId: 'u1', text: 'Canberra, não Sydney.', sensitive: false, requestedAt: Date.now(),
  fromVoice: true, transcript: 'qual a capital da Austrália', ...extra,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('Bootstrap: o initTts está no caminho REAL de boot');

await test('discord/client.js chama initTts dentro do client.once("ready"), depois do setDiscordClient, em try/catch', async () => {
  const s = source('src/discord/client.js');
  const start = s.indexOf("client.once('ready'");
  assert.ok(start > 0, "client.once('ready') existe");
  const end = s.indexOf('\n  });', start);
  const block = s.slice(start, end);
  assert.match(s, /import \{ initTts \} from '\.\.\/services\/tts\/index\.js'/);
  assert.match(s, /import \{ createTtsDeps \} from '\.\.\/handlers\/voiceHandler\.js'/);
  assert.ok(block.includes('setDiscordClient(client)'));
  assert.ok(block.includes('initTts({ client, deps })'), 'initTts é chamado com as deps montadas');
  assert.ok(block.indexOf('initTts(') > block.indexOf('setDiscordClient(client)'), 'depois do setDiscordClient');
  assert.match(block, /try \{[\s\S]*createTtsDeps\([\s\S]*initTts\([\s\S]*\} catch/, 'tudo dentro de try/catch');
  assert.ok(/initTts\(\{ client, deps \}\)\.catch\(/.test(block), 'a promessa não fica solta (nunca vira rejeição não tratada)');
  // As deps recebem tudo que o serviço não pode importar sozinho (evita o ciclo de imports).
  for (const name of ['isToolDisabled', 'getAllMcpTools', 'checkBan', 'forbiddenKeywords', 'hasActiveSession', 'isOpusAvailable']) {
    assert.ok(new RegExp(`createTtsDeps\\(client, \\{[^}]*\\b${name}\\b`).test(block), `createTtsDeps recebe ${name}`);
  }
});

await test('src/index.js usa createDiscordClient (discord/client.js) e NÃO registra events/ready.js (código morto)', async () => {
  const idx = source('src/index.js');
  assert.match(idx, /import \{ createDiscordClient \} from '\.\/discord\/client\.js'/);
  assert.match(idx, /createDiscordClient\(\)/);
  const list = idx.slice(idx.indexOf('const eventFiles = ['), idx.indexOf('];', idx.indexOf('const eventFiles = [')));
  assert.ok(list.includes('interactionCreate.js'), 'a lista de eventos foi lida');
  assert.ok(!/ready\.js/.test(list), 'events/ready.js não é carregado por ninguém');
  assert.ok(!/initTts/.test(source('src/events/ready.js')), 'não há segundo initTts no código morto');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('Interruptor voice_tts (a IA nunca o vê) e painel');

await test('mcp_tools.json: voice_tts existe com defaultDisabled + switchOnly + disableable, sem gatilho textual e sem parâmetros', async () => {
  const tools = JSON.parse(fs.readFileSync(file('src/data/mcp_tools.json'), 'utf8'));
  const names = tools.map((t) => t.function.name);
  assert.equal(names.filter((n) => n === 'voice_tts').length, 1, 'uma única entrada');
  assert.equal(new Set(names).size, names.length, 'nomes únicos');
  const t = tools.find((x) => x.function.name === 'voice_tts');
  assert.equal(t.meta.defaultDisabled, true);
  assert.equal(t.meta.switchOnly, true);
  assert.equal(t.meta.disableable, true);
  assert.ok(typeof t.meta.label === 'string' && t.meta.label.includes('TTS'));
  assert.equal(t.meta.textual_triggers, undefined);
  assert.equal(t.type, 'function');
  assert.deepEqual(Object.keys(t.function.parameters.properties || {}), []);
  // Só ele é interruptor: nenhuma outra ferramenta virou switchOnly por engano.
  assert.deepEqual(tools.filter((x) => x.meta?.switchOnly).map((x) => x.function.name), ['voice_tts']);
});

await test('isToolDisabled(servidor, "voice_tts") é true por padrão; isTtsSwitchOn (e a dep isEnabled) ficam falsos', async () => {
  assert.equal(llm.isToolDisabled('guild-sem-config', 'voice_tts'), true);
  assert.equal(voice.isTtsSwitchOn('guild-sem-config', llm), false);
  const world = makeWorld();
  world.w.switchOn = false;
  assert.equal(voice.createTtsDeps(world.client, world.io).isEnabled('g1'), false);
});

await test('buildToolsPayload e buildToolsDefinition NÃO expõem o interruptor, mesmo com ele ligado no servidor', async () => {
  const tool = llm.getAllMcpTools().find((t) => t.function.name === 'voice_tts');
  const saved = tool.meta.defaultDisabled;
  tool.meta.defaultDisabled = false; // só em memória: simula o servidor com o interruptor ligado (sem gravar server_tools.json)
  try {
    assert.equal(llm.isToolDisabled('guild-sw', 'voice_tts'), false);
    assert.equal(voice.isTtsSwitchOn('guild-sw', llm), true, 'a dep isEnabled enxerga o interruptor ligado');
    const names = llm.buildToolsPayload('guild-sw').map((t) => t.function.name);
    assert.ok(names.length >= 3, 'as demais ferramentas continuam sendo ofertadas');
    assert.ok(!names.includes('voice_tts'));
    const definition = llm.buildToolsDefinition('guild-sw');
    assert.equal(typeof definition, 'string');
    assert.ok(!definition.includes('voice_tts'));
  } finally {
    tool.meta.defaultDisabled = saved;
  }
  assert.equal(llm.isToolDisabled('guild-sw', 'voice_tts'), true);
});

await test('voice_tts fica fora da lista VOICE_TOOLS (entrar/sair da call não liga a fala) e o painel descreve e protege o toggle', async () => {
  const llmSrc = source('src/handlers/llmHandler.js');
  const m = llmSrc.match(/const VOICE_TOOLS = \[([^\]]*)\]/);
  assert.ok(m, 'VOICE_TOOLS encontrado');
  assert.ok(!m[1].includes('voice_tts'));
  const panel = source('src/handlers/mcpToolPanelHandler.js');
  assert.match(panel, /'voice_tts':/, 'TOOL_DESCRIPTIONS tem voice_tts');
  const toggle = panel.slice(panel.indexOf("customId.startsWith('srvmcp_toggle_')"));
  assert.ok(toggle.indexOf('guildId !== interaction.guildId') > 0 && toggle.indexOf('guildId !== interaction.guildId') < toggle.indexOf('setServerToolEnabled'),
    'o toggle só mexe no servidor onde foi clicado, ANTES do setServerToolEnabled');
  // O menu do painel não passa de 25 opções.
  const tools = JSON.parse(fs.readFileSync(file('src/data/mcp_tools.json'), 'utf8'));
  const options = tools.filter((t) => t.meta && t.meta.disableable && t.function.name !== 'leave_voice_call');
  assert.ok(options.some((t) => t.function.name === 'voice_tts'), 'o painel lista voice_tts');
  assert.ok(options.length <= 25, `menu com ${options.length} opções (máximo 25)`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('Persona de voz');

await test('applyVoicePersona põe o bloco de voz no FIM (depois da memória) e usa o texto de reserva sem arquivo', async () => {
  process.env.YUI_PERSONA_VOICE_FILE = 'persona/arquivo-que-nao-existe-tts-test.md';
  try {
    assert.equal(persona.voicePersonaText(), persona.VOICE_PERSONA_FALLBACK);
    const base = 'SISTEMA base\n[MEMÓRIA SOBRE ESTE USUÁRIO — dados] gosta de azul';
    const out = persona.applyVoicePersona(base);
    assert.ok(out.startsWith(base));
    assert.ok(out.endsWith(persona.VOICE_PERSONA_FALLBACK));
    assert.ok(out.indexOf('[MEMÓRIA') < out.indexOf('[MODO VOZ]'), 'a voz vence a memória (vem depois)');
    assert.equal(persona.applyVoicePersona(undefined), `\n\n${persona.VOICE_PERSONA_FALLBACK}`);
  } finally {
    delete process.env.YUI_PERSONA_VOICE_FILE;
  }
  // Com o arquivo padrão existente o bloco continua sendo o de voz.
  assert.match(persona.voicePersonaText(), /\[MODO VOZ\]/);
  // No prompt de sistema real a voz entra depois do memoryBlock.
  const llmSrc = source('src/handlers/llmHandler.js');
  assert.ok(llmSrc.indexOf('baseSystemPrompt += options.memoryBlock') < llmSrc.indexOf('baseSystemPrompt = applyVoicePersona(baseSystemPrompt)'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('voiceGuards (regras puras compartilhadas)');

await test('isVoiceItem: só options.voice === true E mensagem de voz (o rádio também marca isVoice, mas nunca options.voice)', async () => {
  assert.equal(guards.isVoiceItem({ voice: true }, { isVoice: true }), true);
  assert.equal(guards.isVoiceItem({ voice: true }, {}), false);
  assert.equal(guards.isVoiceItem({}, { isVoice: true }), false);
  assert.equal(guards.isVoiceItem({ radioMode: true, radioMCPTools: [], guildId: 'g' }, { isVoice: true, isRadioMode: true }), false);
  assert.equal(guards.isVoiceItem({ voice: 'true' }, { isVoice: true }), false);
  assert.equal(guards.isVoiceItem(undefined, undefined), false);
  assert.equal(guards.isVoiceItem(null, null), false);
});

await test('buildVoiceKey / voiceToolsAllowed / shouldBlockToolForVoice', async () => {
  assert.equal(guards.buildVoiceKey('g1', 'u1'), 'voice:g1:u1');
  assert.equal(guards.voiceToolsAllowed({}), false);
  assert.equal(guards.voiceToolsAllowed({ YUI_VOICE_TOOLS: 'true' }), true);
  assert.equal(guards.voiceToolsAllowed({ YUI_VOICE_TOOLS: ' TRUE ' }), true);
  for (const v of ['false', '1', '', 'sim', 'on']) assert.equal(guards.voiceToolsAllowed({ YUI_VOICE_TOOLS: v }), false, v);
  assert.equal(guards.voiceToolsAllowed(undefined), false);
  assert.equal(guards.shouldBlockToolForVoice({ voice: true }, {}), true);
  assert.equal(guards.shouldBlockToolForVoice({ voice: true }, { YUI_VOICE_TOOLS: 'true' }), false);
  assert.equal(guards.shouldBlockToolForVoice({ voice: false }, {}), false);
  assert.equal(guards.shouldBlockToolForVoice({}, {}), false);
  assert.equal(guards.shouldBlockToolForVoice(undefined, {}), false);
});

await test('isStaleVoiceItem: só voz, só com carimbo válido, e só acima de 30 s', async () => {
  const now = 1_000_000;
  assert.equal(guards.isStaleVoiceItem({ voice: true, voiceRequestedAt: now - 29_000 }, now), false);
  assert.equal(guards.isStaleVoiceItem({ voice: true, voiceRequestedAt: now - 30_000 }, now), false, 'exatamente 30 s ainda vale');
  assert.equal(guards.isStaleVoiceItem({ voice: true, voiceRequestedAt: now - 31_000 }, now), true);
  assert.equal(guards.isStaleVoiceItem({ voice: true, voiceRequestedAt: now - 31_000 }, now, 60), false, 'prazo configurável');
  assert.equal(guards.isStaleVoiceItem({ voice: false, voiceRequestedAt: now - 99_000 }, now), false);
  assert.equal(guards.isStaleVoiceItem({ voice: true }, now), false);
  assert.equal(guards.isStaleVoiceItem({ voice: true, voiceRequestedAt: 0 }, now), false);
  assert.equal(guards.isStaleVoiceItem({ voice: true, voiceRequestedAt: 'x' }, now), false);
  assert.equal(guards.isStaleVoiceItem(undefined, now), false);
});

await test('clipForChat: texto de 5.000 caracteres vira <= 1.900, cortado em fim de frase (ou em espaço); texto curto não muda', async () => {
  const longText = Array.from({ length: 400 }, (_, i) => `Frase numero ${i}.`).join(' ');
  assert.ok(longText.length > 5000);
  const clipped = guards.clipForChat(longText.slice(0, 5000), 1900);
  assert.ok(clipped.length <= 1900 && clipped.length > 900);
  assert.ok(clipped.endsWith('.'), 'termina em fim de frase');
  assert.ok(longText.startsWith(clipped), 'é um prefixo do original');
  const noSpaces = 'a'.repeat(5000);
  assert.equal(guards.clipForChat(noSpaces, 1900).length, 1900, 'sem espaço: corte duro');
  const words = 'palavra '.repeat(900);
  const byWord = guards.clipForChat(words, 1900);
  assert.ok(byWord.length <= 1900 && !byWord.endsWith(' ') && byWord.endsWith('palavra'));
  assert.equal(guards.clipForChat('oi', 1900), 'oi');
  assert.equal(guards.clipForChat(null), '');
  assert.equal(guards.clipForChat(undefined), '');
  assert.equal(guards.clipForChat('x'.repeat(1900), 1900).length, 1900, 'no limite exato não corta');
  assert.equal(guards.VOICE_TOOL_REFUSAL, 'Isso eu faço só pelo chat.');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('voiceHandler: funções puras');

await test('VOICE_TRIGGER_REGEX não tem flag g/y (sem estado) e casa as variações de "Yui"', async () => {
  assert.ok(!/[gy]/.test(voice.VOICE_TRIGGER_REGEX.flags));
  for (let i = 0; i < 6; i += 1) assert.equal(voice.VOICE_TRIGGER_REGEX.test('oi Yui, tudo bem?'), true, 'estável a cada chamada');
  assert.equal(voice.VOICE_TRIGGER_REGEX.test('bom dia pessoal'), false);
  for (const w of ['yui', 'Yuin', 'yukari', 'ikari', 'ricardo']) assert.equal(voice.VOICE_TRIGGER_REGEX.test(`${w} me ajuda`), true, w);
});

await test('parseVoiceCommand: stop / parrot / leave / none', async () => {
  const table = [
    ['para', 'stop'], ['Para!', 'stop'], ['pare', 'stop'], ['chega', 'stop'], ['silêncio', 'stop'], ['cala a boca', 'stop'], ['Yui para', 'stop'],
    ['para que serve o sol?', 'none'], ['chega mais perto', 'none'],
    ['repita depois de mim: eu sou um bobo', 'parrot'], ['Yui, repete exatamente o seguinte texto', 'parrot'],
    ['sai da call', 'leave'], ['Saia do canal de voz', 'leave'], ['desconecta da chamada', 'leave'], ['vaza da call', 'leave'], ['Sai da call, por favor.', 'leave'],
    ['qual a capital da Austrália?', 'none'], ['sai o jogo hoje?', 'none'], ['', 'none'], ['   ', 'none'],
  ];
  for (const [text, expected] of table) assert.equal(voice.parseVoiceCommand(text), expected, JSON.stringify(text));
  assert.equal(voice.parseVoiceCommand(undefined), 'none');
  assert.equal(voice.parseVoiceCommand(null), 'none');
  assert.equal(voice.parseVoiceCommand(42), 'none');
});

await test('parseVoiceTranscript: prompt depois da palavra de ativação; só FALA se ela abrir a frase (3 primeiras palavras)', async () => {
  let r = voice.parseVoiceTranscript('Yui, qual a capital da Austrália?');
  assert.deepEqual({ ...r }, { matched: true, prompt: 'qual a capital da Austrália?', command: 'none', speakable: true });
  r = voice.parseVoiceTranscript('Ei pessoal, hoje o jogo foi ótimo. Yui, que horas são?');
  assert.equal(r.matched, true);
  assert.equal(r.speakable, false, 'a palavra de ativação está no meio da frase: só texto');
  assert.equal(r.prompt, 'que horas são?');
  r = voice.parseVoiceTranscript('Yui');
  assert.equal(r.prompt, 'Olá Yui');
  assert.equal(r.speakable, true);
  assert.equal(voice.parseVoiceTranscript('bom dia a todos').matched, false);
  assert.equal(voice.parseVoiceTranscript('').matched, false);
  assert.equal(voice.parseVoiceTranscript(undefined).matched, false);
  assert.equal(voice.parseVoiceTranscript('Yui, para').command, 'stop');
  assert.equal(voice.parseVoiceTranscript('yui sai da call').command, 'leave');
  assert.equal(voice.parseVoiceTranscript('yui repita depois de mim: oi').command, 'parrot');
});

await test('buildVoiceOptions: TODA transcrição é item de voz; sem palavra de ativação na abertura só ganha voiceSpeak=false (não fala)', async () => {
  const o = voice.buildVoiceOptions({ speakable: true, prompt: 'qual a hora?', now: 1234, env: {} });
  assert.deepEqual({ ...o }, { voice: true, voiceTranscript: 'qual a hora?', disableTools: true, voiceRequestedAt: 1234 });
  assert.equal(voice.buildVoiceOptions({ speakable: true, prompt: 'x', now: 1, env: { YUI_VOICE_TOOLS: 'true' } }).disableTools, false);
  // Palavra de ativação no meio da frase: continua sendo voz (sem ferramentas, escopo público, sem memória), só não fala.
  const silent = voice.buildVoiceOptions({ speakable: false, prompt: 'x', now: 99, env: {} });
  assert.deepEqual({ ...silent }, { voice: true, voiceTranscript: 'x', disableTools: true, voiceRequestedAt: 99, voiceSpeak: false });
  assert.equal(voice.buildVoiceOptions({ speakable: false, prompt: 'x', now: 1, env: { YUI_VOICE_TOOLS: 'true' } }).disableTools, false);
  const empty = voice.buildVoiceOptions({});
  assert.equal(empty.voice, true);
  assert.equal(empty.voiceSpeak, false, 'sem speakable explícito não fala');
});

await test('buildVoiceMessage: canal de texto REAL, voiceKey, isVoice, author.bot=false; reply menciona a pessoa e avisa o onReply', async () => {
  const sent = [];
  const textChannel = { id: 'tc-real', guild: { id: 'g1' }, send: async (p) => { sent.push(p); return { id: 'm1' }; } };
  const seen = [];
  const msg = voice.buildVoiceMessage({
    userId: 'u1', username: 'ana', userTag: 'ana#1', prompt: 'oi', textChannel, guildId: 'g1', now: 777, onReply: (t) => seen.push(t),
  });
  assert.equal(msg.isVoice, true);
  assert.equal(msg.voiceKey, 'voice:g1:u1');
  assert.equal(msg.channelId, 'tc-real', 'ban e AutoMod olham o canal de texto de verdade');
  assert.equal(msg.channel, textChannel);
  assert.equal(msg.guildId, 'g1');
  assert.equal(msg.author.bot, false);
  assert.equal(msg.author.id, 'u1');
  assert.equal(msg.content, 'oi');
  assert.equal(msg.id, 'voice_777');
  assert.equal(msg.mentions.has(), false);
  await msg.reply('olá');
  assert.deepEqual(sent[0], { content: '<@u1> olá' });
  await msg.reply({ content: 'com embed', embeds: [] });
  assert.equal(sent[1].content, '<@u1> com embed');
  await msg.reply('já tem <@u1> aqui');
  assert.equal(sent[2].content, 'já tem <@u1> aqui', 'não duplica a menção');
  assert.deepEqual(seen, ['olá', 'com embed', 'já tem <@u1> aqui']);
  // onReply com defeito não derruba a resposta.
  const bad = voice.buildVoiceMessage({ userId: 'u2', username: 'b', userTag: 'b#1', prompt: 'x', textChannel, guildId: 'g1', onReply: () => { throw new Error('x'); } });
  await bad.reply('ok');
  assert.equal(sent.at(-1).content, '<@u2> ok');
});

await test('createVoiceLimiter: debounce de 6 s, 1 pendente por usuário, 2 por servidor, ficha liberada/expirada, comando só debounce', async () => {
  let t = 0;
  const lim = voice.createVoiceLimiter({ now: () => t });
  const a = lim.tryAccept('g1', 'u1');
  assert.equal(a.ok, true);
  t = 3000;
  assert.equal(lim.tryAccept('g1', 'u1').reason, 'debounce');
  t = 7000;
  assert.equal(lim.tryAccept('g1', 'u1').reason, 'user-pending', 'passou o debounce, mas o 1º pedido ainda espera na fila da IA');
  a.release();
  a.release(); // idempotente
  assert.equal(lim.pendingCount('g1', 'u1'), 0);
  const a2 = lim.tryAccept('g1', 'u1');
  assert.equal(a2.ok, true, 'liberada a vaga e passado o debounce');
  const b = lim.tryAccept('g1', 'u2');
  assert.equal(b.ok, true);
  assert.equal(lim.pendingCount('g1'), 2);
  assert.equal(lim.tryAccept('g1', 'u3').reason, 'guild-pending', 'no máximo 2 por servidor');
  assert.equal(lim.tryAccept('g2', 'u3').ok, true, 'outro servidor não é afetado');
  // A vaga expira sozinha (a fila da IA descarta pedido com mais de 30 s).
  t += voice.VOICE_LIMITS.ttlMs + 1;
  assert.equal(lim.pendingCount('g1'), 0);
  assert.equal(lim.tryAccept('g1', 'u3').ok, true);
  // Comando sem IA (parrot/leave): só o debounce, nunca ocupa vaga.
  t += 10_000;
  const c = lim.tryAccept('g5', 'u1', 'cmd');
  assert.equal(c.ok, true);
  assert.equal(lim.pendingCount('g5'), 0);
  assert.equal(lim.tryAccept('g5', 'u1', 'cmd').reason, 'debounce');
  assert.deepEqual({ ...voice.VOICE_LIMITS }, { debounceMs: 6000, perUser: 1, perGuild: 2, ttlMs: 31000 });
});

await test('buildJoinMessage: explica a fala e o "Yui, para" só quando o TTS está ligado; o aviso da nuvem vale sempre', async () => {
  const on = voice.buildJoinMessage('Sala 1', true);
  const off = voice.buildJoinMessage('Sala 1', false);
  for (const m of [on, off]) {
    assert.match(m, /Sala 1/);
    assert.match(m, /transcrição na nuvem/);
    assert.ok(m.length < 2000);
  }
  // Com a fala ligada nada do pedido é gravado; sem ela o histórico de texto do bot vale, então a promessa é só sobre o áudio.
  assert.match(on, /não gravo nada em disco/);
  assert.match(off, /não gravo o áudio em disco/);
  assert.ok(!/não gravo nada/.test(off), 'sem o modo voz não se promete "nada"');
  assert.match(on, /Respondo falando/);
  assert.match(on, /Yui, para/);
  assert.match(on, /por cima de mim para me interromper/);
  assert.match(on, /não seja em cima da minha voz/, 'a limitação aceita está no texto');
  assert.ok(!/Respondo falando/.test(off));
});

await test('isTtsSwitchOn falha FECHADO: ferramenta ausente, resposta não-booleana e exceções = desligado', async () => {
  const ok = { isToolDisabled: () => false, getAllMcpTools: () => [{ function: { name: 'voice_tts' } }] };
  assert.equal(voice.isTtsSwitchOn('g', ok), true);
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, isToolDisabled: () => true }), false);
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, isToolDisabled: () => undefined }), false);
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, isToolDisabled: () => null }), false);
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, isToolDisabled: () => { throw new Error('x'); } }), false);
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, getAllMcpTools: () => [{ function: { name: 'outra' } }] }), false, 'sem a ferramenta o isToolDisabled diria "ligado"');
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, getAllMcpTools: () => null }), false);
  assert.equal(voice.isTtsSwitchOn('g', { ...ok, getAllMcpTools: () => { throw new Error('x'); } }), false);
  assert.equal(voice.isTtsSwitchOn('g', {}), false);
  assert.equal(voice.isTtsSwitchOn('g'), false);
});

await test('isConfirmedHuman: só quem a Discord confirma como humano (bot, desconhecido e dado parcial não contam)', async () => {
  const world = makeWorld();
  assert.equal(voice.isConfirmedHuman(world.client, 'g1', 'vc1', 'u1'), true);
  assert.equal(voice.isConfirmedHuman(world.client, 'g1', 'vc1', 'b1'), false, 'bot');
  assert.equal(voice.isConfirmedHuman(world.client, 'g1', 'vc1', 'ninguem'), false, 'desconhecido');
  assert.equal(voice.isConfirmedHuman(world.client, 'g1', 'vc1', 'weird'), false, 'user.bot indefinido');
  assert.equal(voice.isConfirmedHuman(world.client, 'g1', 'canal-que-nao-existe', 'u1'), true, 'cai no cache de membros do servidor');
  assert.equal(voice.isConfirmedHuman(null, 'g1', 'vc1', 'u1'), false);
  assert.equal(voice.isConfirmedHuman({ channels: { get cache() { throw new Error('x'); } } }, 'g1', 'vc1', 'u1'), false);
});

await test('containsForbiddenWord: palavra inteira (com acento), trecho para as curtas, falha fechado sem lista; lista real do banHandler', async () => {
  const list = ['porn', 'nsfw', '18+', 'r34', 'ânus', 'ku klux klan', 'puta'];
  assert.equal(voice.containsForbiddenWord('isso é porn mesmo', list), true);
  assert.equal(voice.containsForbiddenWord('pornografia nao e a palavra', list), false, 'palavra inteira');
  assert.equal(voice.containsForbiddenWord('tem 18+ aqui', list), true);
  assert.equal(voice.containsForbiddenWord('olha o r34', list), true);
  assert.equal(voice.containsForbiddenWord('o ÂNUS do bicho', list), true, 'acento e caixa alta');
  assert.equal(voice.containsForbiddenWord('a ku klux klan existiu', list), true);
  assert.equal(voice.containsForbiddenWord('uma disputaria boba', list), false, '"puta" dentro de outra palavra não conta');
  assert.equal(voice.containsForbiddenWord('que puta susto', list), true);
  assert.equal(voice.containsForbiddenWord('Canberra, não Sydney.', list), false);
  assert.equal(voice.containsForbiddenWord('qualquer coisa', undefined), true, 'sem lista: não fala');
  assert.equal(voice.containsForbiddenWord('qualquer coisa', 'nao e lista'), true);
  assert.equal(voice.containsForbiddenWord('vamos falar de hentai', forbiddenKeywords), true);
  assert.equal(voice.containsForbiddenWord('Canberra, não Sydney.', forbiddenKeywords), false);
  assert.equal(voice.containsForbiddenWord('qual a capital da Austrália?', forbiddenKeywords), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('voiceHandler: processVoiceTranscription (fluxo com dublês)');

function makeFlow(overrides = {}) {
  const world = makeWorld();
  const calls = { addToQueue: [], interrupt: [], leave: [] };
  const clock = { t: 0 };
  const io = {
    checkBan: () => null,
    hasActiveSession: () => false,
    interruptSpeech: (g, r) => { calls.interrupt.push([g, r]); return true; },
    leaveVoiceCall: async (g, ch) => { calls.leave.push([g, ch]); return true; },
    // Modo voz LIGADO por padrão nestes fluxos: serviço de TTS de pé + voice_tts ligado no servidor (veja os testes do modo voz DESLIGADO abaixo).
    ttsEnabled: () => true,
    getAllMcpTools: () => [{ function: { name: 'voice_tts' } }],
    isToolDisabled: () => false,
    addToQueue: async (prompt, msg, type, options) => { calls.addToQueue.push({ prompt, msg, type, options }); },
    limiter: voice.createVoiceLimiter({ now: () => clock.t }),
    ...overrides,
  };
  const run = (userId, text) => voice.processVoiceTranscription(userId, text, world.state, world.client, io);
  return { world, calls, clock, io, run };
}

await test('pedido normal: addToQueue com a mensagem de voz (canal real + voiceKey) e options voice/transcript/disableTools/voiceRequestedAt', async () => {
  const f = makeFlow();
  const before = Date.now();
  await f.run('u1', 'Yui, qual a capital da Austrália?');
  assert.equal(f.calls.addToQueue.length, 1);
  const c = f.calls.addToQueue[0];
  assert.equal(c.prompt, 'qual a capital da Austrália?');
  assert.equal(c.type, 'mention');
  assert.equal(c.msg.channelId, 'tc1');
  assert.equal(c.msg.voiceKey, 'voice:g1:u1');
  assert.equal(c.msg.isVoice, true);
  assert.equal(c.msg.author.bot, false);
  assert.equal(c.msg.author.id, 'u1');
  assert.equal(c.options.voice, true);
  assert.equal(c.options.voiceTranscript, 'qual a capital da Austrália?');
  assert.equal(c.options.disableTools, true, 'ferramentas por voz desligadas por padrão');
  assert.ok(c.options.voiceRequestedAt >= before && c.options.voiceRequestedAt <= Date.now() + 5);
  assert.deepEqual(f.calls.interrupt, []);
  assert.deepEqual(f.calls.leave, []);
});

await test('YUI_VOICE_TOOLS=true devolve as ferramentas (disableTools=false); a palavra de ativação no meio da frase = item de voz que NÃO fala (voiceSpeak=false)', async () => {
  process.env.YUI_VOICE_TOOLS = 'true';
  try {
    const f = makeFlow();
    await f.run('u1', 'Yui, toca uma música');
    assert.equal(f.calls.addToQueue[0].options.disableTools, false);
  } finally {
    delete process.env.YUI_VOICE_TOOLS;
  }
  const g = makeFlow();
  await g.run('u2', 'Pessoal, o jogo de ontem foi ótimo, Yui que horas são');
  assert.equal(g.calls.addToQueue.length, 1, 'o pedido continua sendo atendido, em texto');
  const o = g.calls.addToQueue[0].options;
  // Achado da revisão de segurança: antes este caminho ia sem options.voice e burlava tudo (ferramentas por voz, memória, historico.txt).
  assert.equal(o.voice, true, 'continua sendo pedido de voz: sem ferramentas, escopo público, sem memória');
  assert.equal(o.disableTools, true, 'ferramentas por voz continuam desligadas');
  assert.equal(o.voiceSpeak, false, 'mas a resposta não é falada');
  assert.equal(o.voiceTranscript, 'que horas são');
  assert.equal(g.calls.addToQueue[0].msg.channelId, 'tc1');
});

await test('comandos fixos (parar, papagaio, sair da call) só valem com a palavra de ativação ABRINDO a frase', async () => {
  const f = makeFlow();
  await f.run('u1', 'eu acho que a Yui para');
  assert.deepEqual(f.calls.interrupt, [], 'frase de terceiros não cala a Yui');
  assert.equal(f.calls.addToQueue.length, 1, 'vira conversa comum (em texto)');
  assert.equal(f.calls.addToQueue[0].options.voiceSpeak, false);

  const g = makeFlow();
  await g.run('u2', 'eu falei pro Ricardo sai da call');
  assert.equal(g.calls.leave.length, 0, '"Ricardo" no meio da frase não manda a Yui sair');
  assert.equal(g.calls.addToQueue.length, 1);

  const h = makeFlow();
  await h.run('u3', 'pessoal eu acho que Yui repita depois de mim: eu sou um bobo');
  assert.deepEqual(h.world.sent, [], 'sem o texto fixo de papagaio: a IA recusa em texto');
  assert.equal(h.calls.addToQueue.length, 1);

  // Controle: com a palavra de ativação na abertura os três comandos valem.
  const c = makeFlow();
  await c.run('u1', 'Yui, para');
  await c.run('u2', 'Yui, sai da call');
  await c.run('u3', 'Yui, repita depois de mim: oi');
  assert.equal(c.calls.interrupt.length, 1);
  assert.equal(c.calls.leave.length, 1);
  assert.equal(c.world.sent.length, 1);
  assert.equal(c.calls.addToQueue.length, 0);
});

await test('isVoiceModeOn: precisa do serviço de TTS de pé E do interruptor ligado no servidor; qualquer dúvida = desligado', async () => {
  const ok = { ttsEnabled: () => true, isToolDisabled: () => false, getAllMcpTools: () => [{ function: { name: 'voice_tts' } }] };
  assert.equal(await voice.isVoiceModeOn('g1', ok), true);
  assert.equal(await voice.isVoiceModeOn('g1', { ...ok, ttsEnabled: () => false }), false, 'serviço desligado (YUI_TTS_ENABLED, sem Opus...)');
  assert.equal(await voice.isVoiceModeOn('g1', { ...ok, ttsEnabled: () => 'sim' }), false, 'só true exato');
  assert.equal(await voice.isVoiceModeOn('g1', { ...ok, ttsEnabled: () => { throw new Error('x'); } }), false);
  assert.equal(await voice.isVoiceModeOn('g1', { ...ok, isToolDisabled: () => true }), false, 'interruptor desligado no servidor');
  assert.equal(await voice.isVoiceModeOn('g1', { ...ok, isToolDisabled: () => undefined }), false);
  assert.equal(await voice.isVoiceModeOn('g1', { ...ok, getAllMcpTools: () => [] }), false);
  // Sem injeção: usa o getTtsStatus() real (aqui o serviço não está de pé) e o llmHandler real (voice_tts desligado por padrão).
  await tts.shutdownTts();
  assert.equal(await voice.isVoiceModeOn('g-sem-nada', {}), false);
  assert.equal(await voice.isVoiceModeOn('g-sem-nada'), false);
});

await test('modo voz DESLIGADO (o padrão): a conversa por voz é a de antes do TTS (em texto, com ferramentas) e nada do TTS se aplica', async () => {
  for (const off of [{ ttsEnabled: () => false }, { isToolDisabled: () => true }]) {
    const f = makeFlow(off);
    await f.run('u1', 'Yui, qual a capital da Austrália?');
    assert.equal(f.calls.addToQueue.length, 1);
    assert.deepEqual({ ...f.calls.addToQueue[0].options }, {}, 'nenhuma marca de voz: ferramentas, memória e histórico como sempre');
    assert.equal(f.calls.addToQueue[0].msg.isVoice, true, 'a mensagem continua sendo de voz (canal de texto real)');

    // "Yui, para", "repita depois de mim" e o debounce são do modo voz: aqui é conversa comum, sem aviso nem descarte.
    await f.run('u1', 'Yui, para');
    await f.run('u1', 'Yui, repita depois de mim: oi');
    assert.deepEqual(f.calls.interrupt, [], 'sem o modo voz "para" vai para a IA');
    assert.deepEqual(f.world.sent, [], 'sem texto fixo de papagaio');
    assert.equal(f.calls.addToQueue.length, 3, 'sem debounce nem limite de pendentes (nenhum pedido sumiu sem aviso)');
  }
  // sair da call por voz continua funcionando (já valia pelo caminho da IA), desde que a ferramenta esteja liberada.
  const g = makeFlow({ ttsEnabled: () => false });
  await g.run('u1', 'Yui, sai da call');
  assert.equal(g.calls.leave.length, 1);
});

await test('sem palavra de ativação, alucinação de STT, banido e rádio ativo: nada acontece', async () => {
  const a = makeFlow();
  await a.run('u1', 'bom dia pessoal, tudo bem?');
  await a.run('u1', 'Yui, legendas pela comunidade');
  assert.equal(a.calls.addToQueue.length + a.calls.interrupt.length + a.calls.leave.length, 0);
  const b = makeFlow({ checkBan: () => ({ type: 'user', typeName: 'Usuário' }) });
  await b.run('u1', 'Yui, oi');
  await b.run('u1', 'Yui, para');
  assert.equal(b.calls.addToQueue.length + b.calls.interrupt.length, 0);
  const c = makeFlow({ hasActiveSession: () => true });
  await c.run('u1', 'Yui, oi');
  assert.equal(c.calls.addToQueue.length, 0, 'com o rádio ativo a call de IA é ignorada');
});

await test('D7/TG-35: transcrição acima de 1500 caracteres é cortada no FIM antes de seguir ao pipeline; a palavra de ativação e o começo do pedido ficam; o log leva só tamanhos', async () => {
  const { logger } = await import(fileUrl('src/utils/logger.js'));
  const seen = [];
  const original = logger.info;
  const hadOwn = Object.prototype.hasOwnProperty.call(logger, 'info');
  logger.info = (...args) => { seen.push(args.map(String).join(' ')); return logger; };
  try {
    const f = makeFlow();
    await f.run('u9', 'Yui, qual a capital da Austrália? ' + 'blá '.repeat(2000)); // 8000 caracteres de fala
    assert.equal(f.calls.addToQueue.length, 1);
    const c = f.calls.addToQueue[0];
    assert.ok(c.prompt.length <= 1500 && c.prompt.length > 1400, `prompt de ${c.prompt.length} caracteres`);
    assert.ok(c.prompt.startsWith('qual a capital da Austrália? blá'), 'o começo do pedido fica');
    assert.ok(!/\s$/.test(c.prompt));
    assert.equal(c.options.voiceTranscript, c.prompt, 'a transcrição das options é a cortada');
    assert.equal(c.msg.content, c.prompt, 'a mensagem de voz leva o texto cortado');
    assert.equal(c.options.voice, true);
    assert.equal(c.options.voiceSpeak, undefined, 'a palavra de ativação abre a frase: a resposta pode ser falada, como antes');
    // Um segundo pedido longo do mesmo usuário em seguida não enche o log (no máximo um aviso a cada 30 s por usuário).
    f.clock.t = 40000; // passou o prazo do pedido pendente (31 s) e o debounce de 6 s
    await f.run('u9', 'Yui, de novo ' + 'blá '.repeat(2000));
    assert.equal(f.calls.addToQueue.length, 2);
    const cortes = seen.filter((m) => /Transcrição longa cortada de \d+ para \d+ caracteres/.test(m));
    assert.equal(cortes.length, 1, cortes.join(' | '));
    assert.ok(/de 8034 para 14[89]\d caracteres/.test(cortes[0]), cortes[0]);
    assert.ok(!seen.some((m) => m.includes('blá') || m.includes('Austrália')), 'sem o conteúdo da fala no log');
  } finally {
    if (hadOwn) logger.info = original; else delete logger.info;
  }

  // Exatamente 1500 caracteres passam intactos (nada é cortado em fala normal).
  const exato = 'z'.repeat(1495);
  const g = makeFlow();
  await g.run('u1', 'Yui, ' + exato);
  assert.equal(g.calls.addToQueue.length, 1);
  assert.equal(g.calls.addToQueue[0].prompt, exato);

  // Também vale com o modo voz desligado (a conversa por voz em texto): o corte é do pipeline, não do TTS.
  const h = makeFlow({ ttsEnabled: () => false });
  await h.run('u1', 'Yui, ' + 'blá '.repeat(2000));
  assert.equal(h.calls.addToQueue.length, 1);
  assert.ok(h.calls.addToQueue[0].prompt.length <= 1500);
  assert.deepEqual({ ...h.calls.addToQueue[0].options }, {}, 'sem modo voz nada muda além do tamanho');
});

await test('D7/TG-35: a palavra de ativação que só aparece depois do caractere 1500 não aciona a Yui (fala real de 30 s não chega perto disso)', async () => {
  const f = makeFlow();
  await f.run('u1', 'blá '.repeat(500) + 'Yui, que horas são?'); // a palavra de ativação começa no caractere 2000
  assert.equal(f.calls.addToQueue.length + f.calls.interrupt.length + f.calls.leave.length, 0);
  // Controle: a mesma frase com o texto longo DEPOIS da palavra de ativação aciona normalmente.
  const g = makeFlow();
  await g.run('u1', 'Yui, que horas são? ' + 'blá '.repeat(500));
  assert.equal(g.calls.addToQueue.length, 1);
});

await test('D7/TG-35: texto que não é string não derruba o fluxo (vira "sem palavra de ativação")', async () => {
  const f = makeFlow();
  for (const bad of [undefined, null, 42, {}]) await f.run('u1', bad);
  assert.equal(f.calls.addToQueue.length, 0);
  assert.deepEqual(f.world.sent, []);
});

await test('"Yui, para" interrompe a fala sem IA e sem debounce (vale logo depois de um pedido do mesmo usuário)', async () => {
  const f = makeFlow();
  await f.run('u1', 'Yui, qual a capital da Austrália?');
  await f.run('u1', 'Yui, para');
  await f.run('u2', 'Yui, chega');
  assert.deepEqual(f.calls.interrupt, [['g1', 'user-stop'], ['g1', 'user-stop']]);
  assert.equal(f.calls.addToQueue.length, 1, 'o comando não vira pedido de IA');
});

await test('"repita depois de mim": texto fixo no chat ("Essa eu passo."), sem IA', async () => {
  const f = makeFlow();
  await f.run('u1', 'Yui, repita depois de mim: eu sou um bobo');
  assert.equal(f.calls.addToQueue.length, 0);
  assert.deepEqual(f.world.sent, [`<@u1> ${voice.PARROT_REPLY}`]);
  assert.equal(voice.PARROT_REPLY, 'Essa eu passo.');
});

await test('"sai da call": só com leave_voice_call liberado no servidor; senão (ou se o isToolDisabled falhar) é conversa comum', async () => {
  const f = makeFlow();
  await f.run('u1', 'Yui, sai da call');
  assert.equal(f.calls.leave.length, 1);
  assert.equal(f.calls.leave[0][0], 'g1');
  assert.equal(f.calls.leave[0][1], f.world.textChannel);
  assert.equal(f.calls.addToQueue.length, 0);

  const blocked = makeFlow({ isToolDisabled: (g, name) => name === 'leave_voice_call' });
  await blocked.run('u1', 'Yui, sai da call');
  assert.equal(blocked.calls.leave.length, 0, 'ferramenta desligada: não sai');
  assert.equal(blocked.calls.addToQueue.length, 1, 'vira conversa comum');

  const broken = makeFlow({ isToolDisabled: () => { throw new Error('x'); } });
  await broken.run('u1', 'Yui, sai da call');
  assert.equal(broken.calls.leave.length, 0, 'falha fechado');
  assert.equal(broken.calls.addToQueue.length, 1);
});

await test('debounce de 6 s, 1 pendente por usuário (liberado pelo "Processando..."; o aviso de fila não libera) e 2 por servidor', async () => {
  const f = makeFlow();
  await f.run('u1', 'Yui, primeira pergunta');
  f.clock.t = 3000;
  await f.run('u1', 'Yui, segunda pergunta');
  assert.equal(f.calls.addToQueue.length, 1, 'debounce');
  f.clock.t = 7000;
  await f.run('u1', 'Yui, terceira pergunta');
  assert.equal(f.calls.addToQueue.length, 1, 'ainda pendente');
  // O aviso "Sua solicitação está na fila" (addToQueue com a IA ocupada) NÃO libera a vaga.
  await f.calls.addToQueue[0].msg.reply({ content: 'Sua solicitação está na fila. Posição: 2.', fetchReply: true });
  f.clock.t = 14000;
  await f.run('u1', 'Yui, quarta pergunta');
  assert.equal(f.calls.addToQueue.length, 1, 'o aviso de fila não libera');
  // O "Processando..." (o pedido saiu da fila) libera.
  await f.calls.addToQueue[0].msg.reply('🧠 **Processando...**');
  f.clock.t = 21000;
  await f.run('u1', 'Yui, quinta pergunta');
  assert.equal(f.calls.addToQueue.length, 2);

  const g = makeFlow();
  await g.run('u1', 'Yui, pergunta um');
  await g.run('u2', 'Yui, pergunta dois');
  await g.run('u3', 'Yui, pergunta três');
  assert.equal(g.calls.addToQueue.length, 2, 'no máximo 2 pedidos de voz pendentes por servidor');
});

await test('addToQueue com defeito: avisa no chat e libera a vaga (o usuário pode tentar de novo)', async () => {
  let fail = true;
  const f = makeFlow({
    addToQueue: async (prompt, msg, type, options) => { if (fail) throw new Error('boom'); f.calls.addToQueue.push({ prompt, msg, type, options }); },
  });
  await f.run('u1', 'Yui, vai dar erro');
  assert.ok(f.world.sent.some((s) => /Tive um erro ao processar o seu comando de voz/.test(s)));
  fail = false;
  f.clock.t = 7000;
  await f.run('u1', 'Yui, agora vai');
  assert.equal(f.calls.addToQueue.length, 1);
});

section('voiceHandler: handleCapturedAudio (anti-eco antes do STT)');

function loudPcm(bytes = 20000) {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) b.writeInt16LE(i % 4 === 0 ? 3000 : -3000, i);
  return b;
}

function makeCapture(overrides = {}) {
  const world = makeWorld();
  const calls = { stt: [], process: [], overlaps: [] };
  const io = {
    overlapsSpeech: (g, a, b) => { calls.overlaps.push([g, a, b]); return false; },
    transcribeAudio: async (wav) => { calls.stt.push(wav); return 'Yui, oi'; },
    processVoiceTranscription: async (u, text) => { calls.process.push([u, text]); },
    ...overrides,
  };
  const run = (userId, pcm, startedAt) => voice.handleCapturedAudio(userId, pcm, world.state, world.client, startedAt, io);
  return { world, calls, run };
}

await test('trecho que cruza a fala da Yui (mais a margem) NÃO vai ao STT; sem cruzamento vai, com WAV válido', async () => {
  const echo = makeCapture({ overlapsSpeech: () => true });
  await echo.run('u1', loudPcm(), Date.now() - 2000);
  assert.equal(echo.calls.stt.length, 0, 'eco: nunca chega ao STT');
  const ok = makeCapture();
  const started = Date.now() - 2000;
  await ok.run('u1', loudPcm(), started);
  assert.equal(ok.calls.stt.length, 1);
  assert.equal(ok.calls.stt[0].subarray(0, 4).toString(), 'RIFF');
  assert.deepEqual(ok.calls.process, [['u1', 'Yui, oi']]);
  assert.equal(ok.calls.overlaps[0][0], 'g1');
  assert.equal(ok.calls.overlaps[0][1], started);
  assert.ok(ok.calls.overlaps[0][2] >= started);
  // Início desconhecido: a checagem não roda (e o trecho segue o caminho de sempre).
  const unknown = makeCapture({ overlapsSpeech: () => { throw new Error('não deveria perguntar'); } });
  await unknown.run('u1', loudPcm(), undefined);
  assert.equal(unknown.calls.stt.length, 1);
});

await test('anti-eco: o fim do trecho é o FIM REAL da fala (agora menos o silêncio que fecha a captura), nunca o instante da entrega', async () => {
  assert.equal(voice.CAPTURE_END_SILENCE_MS, 1200);
  const src = source('src/handlers/voiceHandler.js');
  assert.ok(src.includes('duration: CAPTURE_END_SILENCE_MS'), 'a captura fecha com a mesma constante que o anti-eco desconta');
  // A captura fechou em t=10.000 (a pessoa parou de falar em 8.800); a fala dela começou em 5.000.
  const a = makeCapture({ now: () => 10_000 });
  await a.run('u1', loudPcm(), 5000);
  assert.deepEqual(a.calls.overlaps[0], ['g1', 5000, 8800]);
  // Trecho curtíssimo: o fim nunca fica antes do começo.
  const b = makeCapture({ now: () => 5600 });
  await b.run('u1', loudPcm(), 5000);
  assert.deepEqual(b.calls.overlaps[0], ['g1', 5000, 5000]);
  // Regressão do achado: a Yui começou a falar em t=9.000 (janela [9000, 11000]); quem terminou de falar em 8.800 NÃO se sobrepõe
  // (antes, com "agora"=10.000, o trecho era descartado sem aviso). Quem ainda falava em 9.500 se sobrepõe.
  const windows = [[9000, 11000]];
  const overlaps = (g, s, e) => windows.some(([w0, w1]) => s <= w1 && e >= w0);
  const early = makeCapture({ now: () => 10_000, overlapsSpeech: overlaps });
  await early.run('u1', loudPcm(), 5000);
  assert.equal(early.calls.stt.length, 1, 'terminou antes da Yui começar: vai ao STT e é atendida');
  const during = makeCapture({ now: () => 10_700, overlapsSpeech: overlaps });
  await during.run('u1', loudPcm(), 5000);
  assert.equal(during.calls.stt.length, 0, 'ainda falava (até 9.500) quando a Yui começou: é eco/sobreposição');
});

await test('trecho curto, silencioso ou de quem está mudo não vai ao STT; limite de requisições avisa o chat', async () => {
  const a = makeCapture();
  await a.run('u1', Buffer.alloc(9000), Date.now());
  await a.run('u1', Buffer.alloc(20000), Date.now());
  assert.equal(a.calls.stt.length, 0);
  const b = makeCapture();
  b.world.members.get('u1').voice.selfMute = true;
  await b.run('u1', loudPcm(), Date.now());
  assert.equal(b.calls.stt.length, 0);
  const c = makeCapture({ transcribeAudio: async () => ({ isRateLimit: true }) });
  await c.run('u1', loudPcm(), Date.now());
  assert.ok(c.world.sent.some((s) => /Limite de requisições/.test(s)));
  assert.equal(c.calls.process.length, 0);
});

section('voiceHandler: setupVoiceReceiver (bots ignorados, barge-in e ouvintes sem empilhar)');

function makeReceiver() {
  const receiver = {
    speaking: new EventEmitter(),
    subscribed: [],
    streams: [],
    subscribe(userId) {
      receiver.subscribed.push(userId);
      const s = new PassThrough();
      receiver.streams.push(s);
      return s;
    },
  };
  return receiver;
}

await test('bot e membro desconhecido nunca são captados nem avisam o TTS; humano é captado e avisa início/fim (barge-in)', async () => {
  const world = makeWorld();
  const manager = makeFakeManager();
  await startTts(world, { manager });
  const receiver = makeReceiver();
  world.connection.receiver = receiver;
  voice.setupVoiceReceiver(world.state, world.client);

  receiver.speaking.emit('start', 'b1');
  receiver.speaking.emit('start', 'ninguem');
  receiver.speaking.emit('start', 'weird');
  await tick();
  assert.deepEqual(receiver.subscribed, [], 'bot, desconhecido e dado parcial: nenhuma captura');
  assert.deepEqual(manager.noted.filter(([, , s]) => s === true), [], 'e o TTS não é avisado');

  receiver.speaking.emit('start', 'u1');
  await tick();
  assert.deepEqual(receiver.subscribed, ['u1']);
  assert.deepEqual(manager.noted.filter(([, , s]) => s === true), [['g1', 'u1', true]]);
  receiver.speaking.emit('end', 'u1');
  assert.deepEqual(manager.noted.at(-1), ['g1', 'u1', false]);
  // 'end' repetido e de quem nunca começou: apenas repassa (o serviço é idempotente).
  receiver.speaking.emit('end', 'u1');
  for (const s of receiver.streams) s.end();
  await tick();
  await tts.shutdownTts();
});

await test('joinVoiceCall repetido (setup de novo no mesmo receiver) NÃO empilha ouvintes, nem depois de a escuta ser desligada e recriada', async () => {
  const world = makeWorld();
  const receiver = makeReceiver();
  world.connection.receiver = receiver;
  const h1 = voice.setupVoiceReceiver(world.state, world.client);
  assert.equal(receiver.speaking.listenerCount('start'), 2, 'captura + aviso de fala');
  assert.equal(receiver.speaking.listenerCount('end'), 1);
  const h2 = voice.setupVoiceReceiver(world.state, world.client);
  assert.equal(h2, h1, 'reaproveita o ouvinte');
  assert.equal(receiver.speaking.listenerCount('start'), 2);
  assert.equal(receiver.speaking.listenerCount('end'), 1);
  // A escuta foi desligada por falhas seguidas (o ouvinte principal sai do receiver): recria sem duplicar o aviso de fala.
  for (let i = 0; i < 5; i += 1) h1.guard.fail(`k${i}`);
  h1.detach();
  assert.equal(h1.guard.isDisabled(), true);
  const h3 = voice.setupVoiceReceiver(world.state, world.client);
  assert.notEqual(h3, h1);
  assert.equal(receiver.speaking.listenerCount('start'), 2);
  assert.equal(receiver.speaking.listenerCount('end'), 1);
  h3.detach();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('createTtsDeps + initTts: todas as dependências síncronas e fechadas');

await test('createTtsDeps entrega todas as funções que o serviço usa, todas síncronas', async () => {
  const world = makeWorld();
  const deps = voice.createTtsDeps(world.client, world.io);
  const expected = ['isEnabled', 'isBanned', 'isBot', 'isRadioActive', 'isAiCallActive', 'isUserInSameVoice', 'canSpeakInChannel',
    'containsForbidden', 'matchesTrigger', 'resolveName', 'isOpusAvailable', 'isStageChannel'];
  for (const name of expected) assert.equal(typeof deps[name], 'function', name);
  const probes = [deps.isEnabled('g1'), deps.isBanned('u1', 'g1'), deps.isBot('u1', 'g1'), deps.isRadioActive('g1'), deps.isAiCallActive('g1'),
    deps.isUserInSameVoice('g1', 'u1'), deps.canSpeakInChannel('g1'), deps.containsForbidden('oi'), deps.matchesTrigger('oi'),
    deps.resolveName('g1', 'u1', 'user'), deps.isOpusAvailable(), deps.isStageChannel('g1', world.connection)];
  for (const p of probes) assert.ok(!(p && typeof p.then === 'function'), 'nenhuma devolve promessa');
});

await test('isBot: false EXATO só para humano confirmado; bot, desconhecido, dado parcial e call inexistente = true', async () => {
  const world = makeWorld();
  const deps = voice.createTtsDeps(world.client, world.io);
  assert.strictEqual(deps.isBot('u1', 'g1'), false);
  assert.strictEqual(deps.isBot('b1', 'g1'), true);
  assert.strictEqual(deps.isBot('ninguem', 'g1'), true);
  assert.strictEqual(deps.isBot('weird', 'g1'), true);
  assert.strictEqual(deps.isBot('u1', 'g-sem-call'), true);
});

await test('isBanned usa o canal de texto da call e falha como banido; isRadioActive falha como ativo; isEnabled segue o interruptor', async () => {
  const world = makeWorld();
  const deps = voice.createTtsDeps(world.client, world.io);
  assert.strictEqual(deps.isBanned('u1', 'g1'), false);
  assert.deepEqual(world.w.banArgs.at(-1), ['u1', 'g1', 'tc1']);
  world.w.banned.add('u2');
  assert.strictEqual(deps.isBanned('u2', 'g1'), true);
  const broken = voice.createTtsDeps(world.client, { ...world.io, checkBan: () => { throw new Error('x'); }, hasActiveSession: () => { throw new Error('x'); } });
  assert.strictEqual(broken.isBanned('u1', 'g1'), true);
  assert.strictEqual(broken.isRadioActive('g1'), true);
  assert.strictEqual(deps.isRadioActive('g1'), false);
  world.w.radio = true;
  assert.strictEqual(deps.isRadioActive('g1'), true);
  world.w.switchOn = false;
  assert.strictEqual(deps.isEnabled('g1'), false);
  world.w.switchOn = true;
  assert.strictEqual(deps.isEnabled('g1'), true);
  world.w.tools = [{ function: { name: 'outra' } }];
  assert.strictEqual(deps.isEnabled('g1'), false, 'ferramenta ausente: desligado');
});

await test('isAiCallActive: só com a conexão ATUAL registrada, pronta e sem estar saindo (o rádio troca a conexão)', async () => {
  const world = makeWorld();
  const deps = voice.createTtsDeps(world.client, world.io);
  assert.strictEqual(deps.isAiCallActive('g1'), true);
  world.w.status = 'connecting';
  assert.strictEqual(deps.isAiCallActive('g1'), false);
  world.w.status = 'ready';
  world.w.leaving = true;
  assert.strictEqual(deps.isAiCallActive('g1'), false);
  world.w.leaving = false;
  assert.strictEqual(deps.isAiCallActive('g-outro'), false, 'sem call registrada');
  const other = voice.createTtsDeps(world.client, { ...world.io, getConnection: () => ({ state: { status: 'ready' } }) });
  assert.strictEqual(other.isAiCallActive('g1'), false, 'outra conexão no lugar da registrada');
});

await test('isUserInSameVoice e canSpeakInChannel', async () => {
  const world = makeWorld();
  const deps = voice.createTtsDeps(world.client, world.io);
  assert.strictEqual(deps.isUserInSameVoice('g1', 'u1'), true);
  assert.strictEqual(deps.isUserInSameVoice('g1', 'ninguem'), false, 'fora do cache');
  world.w.userChannel = 'outro';
  assert.strictEqual(deps.isUserInSameVoice('g1', 'u1'), false);
  world.w.userChannel = 'vc1';
  world.w.meChannel = 'outro';
  assert.strictEqual(deps.isUserInSameVoice('g1', 'u1'), false);
  world.w.meChannel = 'vc1';
  assert.strictEqual(deps.isUserInSameVoice('g-sem-call', 'u1'), false);

  assert.strictEqual(deps.canSpeakInChannel('g1'), true);
  world.w.canSpeak = false;
  assert.strictEqual(deps.canSpeakInChannel('g1'), false, 'sem permissão de Falar');
  world.w.canSpeak = true;
  world.w.serverMute = true;
  assert.strictEqual(deps.canSpeakInChannel('g1'), false, 'silenciada pelo servidor');
  world.w.serverMute = false;
  world.w.suppress = true;
  assert.strictEqual(deps.canSpeakInChannel('g1'), false, 'suprimida (palco)');
  world.w.suppress = false;
  assert.strictEqual(deps.canSpeakInChannel('g-sem-call'), false);
  assert.strictEqual(deps.isStageChannel('g1', world.connection), false);
  world.w.channelType = ChannelType.GuildStageVoice;
  assert.strictEqual(deps.isStageChannel('g1', world.connection), true);
});

await test('containsForbidden, matchesTrigger (sem estado), resolveName (só cache) e isOpusAvailable', async () => {
  const world = makeWorld();
  const deps = voice.createTtsDeps(world.client, world.io);
  assert.strictEqual(deps.containsForbidden('isso é nsfw'), true);
  assert.strictEqual(deps.containsForbidden('Canberra, não Sydney.'), false);
  assert.strictEqual(voice.createTtsDeps(world.client, {}).containsForbidden('x'), true, 'sem lista: fecha');
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(deps.matchesTrigger('a Yui falou'), true);
    assert.strictEqual(deps.matchesTrigger('nada a ver'), false);
  }
  // A voz lê "Yuí" como "Yui" e o STT escreve "Yui": a forma com acento também conta como gatilho (a regex pura não a casa).
  assert.strictEqual(voice.VOICE_TRIGGER_REGEX.test('Yuí'), false, 'a regex pura não casa a forma acentuada');
  for (const t of ['Yuí', 'oi YÚI', 'a Yüi falou', 'Ricardó chegou']) assert.strictEqual(deps.matchesTrigger(t), true, t);
  assert.strictEqual(deps.matchesTrigger(undefined), false);
  assert.strictEqual(deps.matchesTrigger(null), false);
  assert.equal(deps.resolveName('g1', 'u1', 'user'), 'Nome u1');
  assert.equal(deps.resolveName('g1', 'r1', 'role'), 'Moderadores');
  assert.equal(deps.resolveName('g1', 'tc1', 'channel'), 'geral');
  assert.equal(deps.resolveName('g1', 'fantasma', 'user'), null);
  assert.equal(deps.resolveName('g-nenhum', 'u1', 'user'), null);
  assert.strictEqual(deps.isOpusAvailable(), true);
  world.w.opus = false;
  assert.strictEqual(deps.isOpusAvailable(), false);
  assert.strictEqual(voice.createTtsDeps(world.client, { isOpusAvailable: () => { throw new Error('x'); } }).isOpusAvailable(), false);
});

await test('com as deps REAIS, o serviço só fala quando TODOS os portões abrem (uma razão por portão); sem transcript não fala', async () => {
  const world = makeWorld();
  const { manager } = await startTts(world);
  let n = 0;
  const user = () => `u${(n += 1)}`; // cada caso com um usuário novo (o limitador conta falas por usuário)

  const okReply = tts.speakVoiceReply(req({ userId: user() }));
  assert.deepEqual({ ok: okReply.ok, reason: okReply.reason }, { ok: true, reason: 'queued' });
  assert.equal(manager.enqueued.length, 1);
  assert.equal(manager.enqueued[0].guildId, 'g1');

  const reasons = [];
  const attempt = (label, extra, mutate, restore) => {
    mutate?.();
    try {
      const r = tts.speakVoiceReply(req({ userId: user(), ...extra }));
      reasons.push([label, r.reason]);
      assert.equal(r.ok, false, label);
    } finally { restore?.(); }
  };
  attempt('sem transcript', { transcript: undefined });
  attempt('transcript vazio', { transcript: '   ' });
  attempt('não veio da voz', { fromVoice: false });
  attempt('sensível', { sensitive: true });
  attempt('sensível ausente', { sensitive: undefined });
  attempt('interruptor desligado', {}, () => { world.w.switchOn = false; }, () => { world.w.switchOn = true; });
  attempt('rádio ativo', {}, () => { world.w.radio = true; }, () => { world.w.radio = false; });
  attempt('call não pronta', {}, () => { world.w.status = 'signalling'; }, () => { world.w.status = 'ready'; });
  attempt('fora da call', {}, () => { world.w.userChannel = 'outro'; }, () => { world.w.userChannel = 'vc1'; });
  attempt('sem permissão de Falar', {}, () => { world.w.canSpeak = false; }, () => { world.w.canSpeak = true; });
  attempt('pedido velho', { requestedAt: Date.now() - 60_000 });
  attempt('opus ausente', {}, () => { world.w.opus = false; }, () => { world.w.opus = true; });
  const expected = {
    'sem transcript': 'no-transcript', 'transcript vazio': 'no-transcript', 'não veio da voz': 'not-voice', 'sensível': 'sensitive',
    'sensível ausente': 'sensitive', 'interruptor desligado': 'guild-disabled', 'rádio ativo': 'radio-active', 'call não pronta': 'no-connection',
    'fora da call': 'user-not-in-call', 'sem permissão de Falar': 'no-speak-permission', 'pedido velho': 'stale', 'opus ausente': 'tts-off',
  };
  for (const [label, reason] of reasons) assert.equal(reason, expected[label], `${label}: ${reason}`);
  assert.equal(manager.enqueued.length, 1, 'nenhum dos casos acima chegou à fila de fala');

  // Bot, banido, texto proibido e eco do pedido também não falam.
  assert.equal(tts.speakVoiceReply(req({ userId: 'b1' })).reason, 'bot-user');
  assert.equal(tts.speakVoiceReply(req({ userId: 'weird' })).reason, 'bot-user');
  world.w.banned.add('u39');
  assert.equal(tts.speakVoiceReply(req({ userId: 'u39' })).reason, 'banned');
  assert.equal(tts.speakVoiceReply(req({ userId: user(), text: 'isso é nsfw' })).reason, 'blocked-word');
  assert.equal(tts.speakVoiceReply(req({ userId: user(), text: 'Eu sou a Yui, tudo bem?' })).reason, 'self-trigger', 'a Yui falando o nome acionaria o microfone de novo');
  assert.equal(tts.speakVoiceReply(req({ userId: user(), text: 'qual a capital da Austrália', transcript: 'qual a capital da Austrália' })).reason, 'echo-of-input');
  assert.equal(manager.enqueued.length, 1);
  await tts.shutdownTts();
});

await test('API de controle chega ao gerenciador: interruptSpeech, disposeGuild, noteHumanSpeaking, overlapsSpeech', async () => {
  const world = makeWorld();
  const { manager } = await startTts(world);
  assert.equal(tts.interruptSpeech('g1', 'radio'), true);
  assert.deepEqual(manager.interrupts.at(-1), ['g1', 'radio']);
  assert.equal(tts.disposeGuild('g1'), true);
  assert.deepEqual(manager.disposed.at(-1), ['g1', 'disposed']);
  tts.noteHumanSpeaking('g1', 'u1', true);
  assert.deepEqual(manager.noted.at(-1), ['g1', 'u1', true]);
  manager.windows.push({ start: 1000, end: 2000 });
  assert.equal(tts.overlapsSpeech('g1', 1500, 1600), true);
  assert.equal(tts.overlapsSpeech('g1', 5000, 6000), false);
  await tts.shutdownTts();
  // Sem o serviço ligado tudo é inerte e nunca lança.
  assert.equal(tts.interruptSpeech('g1', 'radio'), false);
  assert.equal(tts.disposeGuild('g1'), false);
  assert.equal(tts.overlapsSpeech('g1', 1, 2), false);
  assert.deepEqual(tts.speakVoiceReply(req()), { ok: false, reason: 'tts-off' });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('Fiação de PRODUÇÃO da saída de áudio (registro de conexões do @discordjs/voice)');

await test('sem manager injetado, a Yui FALA na conexão que o voiceHandler registra (o @discordjs/voice ESM): sem "no-connection"', async () => {
  // Achado da revisão de fluxo: o output.js pegava o @discordjs/voice por require (cópia CJS, OUTRO registro de conexões) e o voiceHandler
  // entra na call por import (cópia ESM). getVoiceConnection voltava sempre vazio: o texto ia ao chat e nunca saía som. Os outros testes
  // injetam o gerenciador e por isso nunca viram isso; aqui o gerenciador é o PADRÃO de produção (initTts monta o seu).
  const esm = await import('@discordjs/voice'); // o mesmo especificador que o voiceHandler.js usa
  const world = makeWorld();
  const conn = esm.joinVoiceChannel({ channelId: 'vc1', guildId: 'g1', adapterCreator: () => ({ sendPayload: () => true, destroy() {} }) });
  const packets = [];
  // Conexão REAL (registrada no ESM) forçada a Ready, com um "networking" que só conta os pacotes Opus enviados.
  conn.state = {
    status: 'ready',
    adapter: conn.state.adapter,
    networking: {
      state: { code: 4 }, on() {}, off() {}, once() {}, destroy() {}, setSpeaking() {},
      prepareAudioPacket(buf) { this.prepared = buf; return buf; },
      dispatchAudio() { if (this.prepared) { packets.push(this.prepared); this.prepared = undefined; } return true; },
    },
  };
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };
  try {
    assert.ok(esm.getVoiceConnection('g1'), 'a conexão está no registro ESM');
    await tts.shutdownTts();
    const init = await tts.initTts({
      client: world.client,
      deps: voice.createTtsDeps(world.client, world.io),
      overrides: { providers: [createFakeProvider({ name: 'fake' })], logger }, // SEM manager: o caminho de produção
    });
    assert.equal(init.enabled, true, JSON.stringify(init));
    const queued = tts.speakVoiceReply(req());
    assert.deepEqual({ ok: queued.ok, reason: queued.reason }, { ok: true, reason: 'queued' });
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && Object.keys(tts.getTtsStatus().counters.finished).length === 0) await new Promise((r) => setTimeout(r, 25));
    const counters = tts.getTtsStatus().counters;
    assert.deepEqual(counters.finished, { done: 1 }, `a fala devia terminar normalmente: ${JSON.stringify(counters.finished)} | ${logs.join(' | ')}`);
    assert.equal(counters.spoken, 1);
    assert.ok(packets.length >= 20, `pacotes de voz enviados à conexão: ${packets.length}`);
    assert.ok(!logs.some((l) => /no-connection/.test(l)), 'nenhum fim de fala por no-connection');
  } finally {
    await tts.shutdownTts();
    try { conn.destroy(); } catch { /* já destruída */ }
  }
});

await test('o index.js entrega ao gerenciador o MESMO @discordjs/voice do bot (import dinâmico ESM) e o output.js documenta o registro duplo', async () => {
  const idx = source('src/services/tts/index.js');
  assert.ok(idx.includes("await import('@discordjs/voice')"), 'initTts precisa carregar o @discordjs/voice como ESM');
  assert.ok(idx.includes('voice: voiceLib'), 'e passá-lo ao createSpeakerManager');
  const out = source('src/services/tts/output.js');
  assert.ok(out.includes('options.voice ?? (needsRealVoice ? loadVoice() : null)'), 'o gerenciador usa options.voice antes do plano B (require)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('llmHandler: despacho de ferramenta, gancho de fala e escopo público');

await test('voiceToolBlocked: com options.voice e sem YUI_VOICE_TOOLS toda ferramenta é descartada (menos generate_reply)', async () => {
  const v = { voice: true };
  for (const tool of ['search_web', 'download_audio', 'generate_image', 'join_voice_call', 'leave_voice_call', 'ia_automod', 'radio_play']) {
    assert.equal(llm.voiceToolBlocked(tool, v, {}), true, tool);
  }
  assert.equal(llm.voiceToolBlocked('generate_reply', v, {}), false, 'generate_reply é só o texto da resposta');
  assert.equal(llm.voiceToolBlocked('search_web', v, { YUI_VOICE_TOOLS: 'true' }), false, 'YUI_VOICE_TOOLS=true devolve o comportamento antigo');
  assert.equal(llm.voiceToolBlocked('search_web', {}, {}), false, 'texto comum não é afetado');
  assert.equal(llm.voiceToolBlocked('search_web', { radioMode: true }, {}), false, 'o rádio não é voz');
  assert.equal(llm.voiceToolBlocked(null, v, {}), false);
  assert.equal(llm.voiceToolBlocked('', v, {}), false);
});

await test('o despacho do llmHandler usa o guarda ANTES de executar qualquer ferramenta e responde o texto fixo (nunca o JSON)', async () => {
  const s = source('src/handlers/llmHandler.js');
  const guard = s.indexOf('voiceToolBlocked(toolData.tool, options)');
  assert.ok(guard > 0, 'o guarda está no despacho');
  assert.ok(guard < s.indexOf("toolData.tool === 'join_voice_call'"), 'antes de qualquer ferramenta ser executada');
  assert.ok(guard < s.indexOf("toolData.tool === 'leave_voice_call'"));
  const after = s.slice(guard, guard + 2500);
  assert.match(after, /toolData\.tool = null/);
  assert.match(after, /processedResponse = VOICE_TOOL_REFUSAL/);
  assert.match(s, /import \{[^}]*VOICE_TOOL_REFUSAL[^}]*\} from '\.\.\/services\/tts\/voiceGuards\.js'/);
});

await test('gancho de fala [TTS-HOOK]: só item de voz, depois da entrega confirmada, sem await, com transcript/requestedAt/fromVoice/sensitive corretos', async () => {
  const s = source('src/handlers/llmHandler.js');
  const mark = s.indexOf('[TTS-HOOK]');
  assert.ok(mark > 0);
  const delivered = s.lastIndexOf('await unifiedReply(processedResponse)', mark);
  assert.ok(delivered > 0 && delivered < mark, 'o gancho vem depois de entregar o texto no chat');
  const hook = s.slice(mark, s.indexOf('PONTO "APÓS ENTREGA"', mark));
  assert.match(hook, /if \(voiceSpeak && delivery\.ok && sentMessage\)/, 'só voz FALADA (voiceSpeak) e só com entrega confirmada');
  assert.match(s, /const voiceSpeak = isVoice && options\.voiceSpeak !== false;/, 'voiceSpeak = item de voz que não pediu para ficar mudo');
  const call = hook.slice(hook.indexOf('speakVoiceReply({'), hook.indexOf('});', hook.indexOf('speakVoiceReply({')) + 3);
  for (const piece of ['guildId', 'userId', 'text: processedResponse', 'transcript: options.voiceTranscript', "sensitive: coreCtx.memoryScope === 'personal'",
    'requestedAt: options.voiceRequestedAt', 'fromVoice: true']) {
    assert.ok(call.includes(piece), `speakVoiceReply recebe ${piece}`);
  }
  assert.ok(!/await\s+speakVoiceReply/.test(s), 'sem await: nunca atrasa a resposta');
  assert.match(hook, /try \{[\s\S]*speakVoiceReply[\s\S]*\} catch/);
  assert.match(s, /import \{ interruptSpeech, speakVoiceReply \} from '\.\.\/services\/tts\/index\.js'/);
  // O serviço não pode importar o llmHandler (ciclo): as deps vêm de fora.
  for (const f of fs.readdirSync(file('src/services/tts')).filter((x) => x.endsWith('.js'))) {
    assert.ok(!/handlers\/(llmHandler|voiceHandler|banHandler)/.test(source(`src/services/tts/${f}`)), `${f} não importa handlers`);
  }
});

await test('contextFromDiscord com channelId null = escopo PÚBLICO mesmo para o dono (voz nunca usa memória pessoal)', async () => {
  const owner = contextFromDiscord({ userId: '111', guildId: 'g1', channelId: null });
  assert.equal(owner.memoryScope, 'public');
  const voiceKeyAsChannel = contextFromDiscord({ userId: '111', guildId: 'g1', channelId: guards.buildVoiceKey('g1', '111') });
  assert.equal(voiceKeyAsChannel.memoryScope, 'public');
  // Controles: o teste enxerga o escopo pessoal quando ele existe.
  assert.equal(contextFromDiscord({ userId: '111', guildId: 'g1', channelId: 'priv1' }).memoryScope, 'personal', 'canal privado do dono');
  assert.equal(contextFromDiscord({ userId: '111', guildId: null, channelId: null }).memoryScope, 'personal', 'DM do dono');
  assert.equal(contextFromDiscord({ userId: '222', guildId: 'g1', channelId: null }).memoryScope, 'public');
  // O llmHandler monta o item de voz sem canal para o escopo e com o canal real para o ban.
  const s = source('src/handlers/llmHandler.js');
  assert.match(s, /const channelId = isVoice \? buildVoiceKey\(guildId, userId\) : realChannelId/);
  assert.match(s, /checkBan\(userId, guildId, channelId\)|checkBan\(userId, guildId \|\| null, null\)/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('Fiação do voiceHandler, do rádio e do /status');

await test('voiceHandler: usa o serviço novo (interruptSpeech/disposeGuild/noteHumanSpeaking/overlapsSpeech/warmupTts) na ordem certa', async () => {
  const s = source('src/handlers/voiceHandler.js');
  assert.match(s, /from '\.\.\/services\/tts\/index\.js'/);
  for (const name of ['interruptSpeech', 'disposeGuild', 'noteHumanSpeaking', 'overlapsSpeech', 'warmupTts', 'isStopCommand', 'isParrotRequest', 'wakeWordInFirstWords']) {
    assert.match(s, new RegExp(`\\b${name}\\b`), name);
  }
  // Saída de verdade: o Disconnected só conclui a queda DEPOIS do entersState de 5 s; só então limpa a fala.
  const dc = s.slice(s.indexOf('connection.on(VoiceConnectionStatus.Disconnected'));
  const reentry = dc.indexOf('entersState(connection, VoiceConnectionStatus.Signalling, 5000)');
  assert.ok(reentry > 0, 'espera a reconexão antes de dar a queda como certa');
  assert.ok(dc.indexOf('entersState(connection, VoiceConnectionStatus.Connecting, 5000)') > 0);
  assert.ok(reentry < dc.indexOf('cleanupVoiceSession(guildId)'), 'disposeGuild só depois do entersState');
  // leaveVoiceCall limpa a fala ANTES de destruir a conexão.
  const leave = s.slice(s.indexOf('async function leaveVoiceCall'), s.indexOf('function setupVoiceReceiver'));
  assert.ok(leave.indexOf('cleanupVoiceSession(guildId)') > 0 && leave.indexOf('cleanupVoiceSession(guildId)') < leave.indexOf('connection.destroy()'));
  const clean = s.slice(s.indexOf('function cleanupVoiceSession'));
  assert.ok(clean.indexOf('disposeGuild(guildId)') > 0);
  assert.match(clean, /clearVoiceHistory/, 'limpa o histórico de voz do llmHandler');
  assert.equal(typeof llm.clearVoiceHistory, 'function', 'o llmHandler exporta clearVoiceHistory');
  assert.equal(llm.clearVoiceHistory('g-qualquer'), 0);
  // Entrada: aquece sem bloquear; a mensagem vem do builder testado acima.
  const join = s.slice(s.indexOf('async function joinVoiceCall'), s.indexOf('async function leaveVoiceCall'));
  assert.match(join, /warmupTts\(\)\.catch/);
  assert.ok(!/await\s+warmupTts/.test(join), 'o aquecimento nunca bloqueia a entrada');
  assert.match(join, /buildJoinMessage\(voiceChannel\.name, ttsOn\)/);
  // Anti-eco antes do STT; ordem do fluxo de comando; ignorar bots no precheck.
  const cap = s.slice(s.indexOf('async function handleCapturedAudio'), s.indexOf('async function processVoiceTranscription'));
  assert.ok(cap.indexOf('overlapsSpeech') > 0 && cap.indexOf('overlapsSpeech') < cap.indexOf('transcribeAudio'));
  const proc = s.slice(s.indexOf('async function processVoiceTranscription'), s.indexOf('async function handleVoiceStateUpdate'));
  const order = ['parseVoiceTranscript(text)', "'user-stop'", 'isToolDisabled', 'tryAccept(', 'PARROT_REPLY', 'buildVoiceMessage(', 'buildVoiceOptions(', 'addToQueue)('];
  let last = -1;
  for (const piece of order) {
    const at = proc.indexOf(piece);
    assert.ok(at > last, `${piece} na ordem esperada`);
    last = at;
  }
  assert.match(s, /precheck: \(userId\) => \{\s*\/\/[^\n]*\n\s*if \(!isConfirmedHuman\(/, 'o precheck ignora bots antes de tudo');
  assert.match(s, /ctx\.segments\.set\(userId, Date\.now\(\)\)/, 'guarda o início do trecho no precheck');
  assert.ok(!/console\.(log|warn|error)/.test(s), 'sem console.* na voz (nada de fala em log)');
});

await test('radioManager: interrompe a fala ao criar a sessão e a mensagem do rádio NUNCA ganha options.voice', async () => {
  const s = source('src/music/radioManager.js');
  assert.match(s, /import \{ interruptSpeech \} from '\.\.\/services\/tts\/index\.js'/);
  const create = s.indexOf('createSession(guildId, voiceChannel.id, textChannel.id)');
  const interrupt = s.indexOf("interruptSpeech(guildId, 'radio')");
  assert.ok(create > 0 && interrupt > create, 'logo depois de criar a sessão');
  assert.match(s.slice(interrupt - 20, interrupt + 60), /try \{ interruptSpeech/, 'em try/catch');
  const call = s.slice(s.indexOf("await addToQueue(prompt, contextMessage, 'mention', {"));
  const options = call.slice(0, call.indexOf('});') + 3);
  assert.ok(options.includes('radioMode: true'));
  assert.ok(!/\bvoice\s*:/.test(options) && !/voiceTranscript|voiceRequestedAt/.test(options), 'sem options.voice');
  assert.equal(guards.isVoiceItem({ radioMode: true, radioMCPTools: [], guildId: 'g' }, { isVoice: true, isRadioMode: true }), false);
});

await test('/status: uma linha de TTS só com contagens (nunca IDs de servidor nem texto); sem detailed', async () => {
  const s = source('src/discord/commands/status.js');
  assert.match(s, /getTtsStatus\(\)/);
  const code = s.replace(/^\s*\/\/.*$/gm, ''); // sem os comentários, que explicam justamente o que NÃO se faz
  assert.match(code, /getTtsStatus\(\)/);
  assert.ok(!/getTtsStatus\(\s*\{/.test(code), 'a lista com IDs de servidores (detailed) exige o dono: não é usada aqui');
  const off = statusCmd.formatTtsStatusLine({ initialized: false, enabled: false, reason: 'not-initialized' });
  assert.match(off, /desligada/);
  // O motivo sai em português (nunca o código interno em inglês).
  assert.match(off, /ainda não iniciou/);
  assert.ok(!/not-initialized/.test(off));
  for (const [code, text] of [['no-opus', /Opus/], ['disabled', /YUI_TTS_ENABLED/], ['no-providers', /provedor/], ['init-error', /falhou/], ['shutdown', /encerrada/]]) {
    const line = statusCmd.formatTtsStatusLine({ initialized: false, enabled: false, reason: code });
    assert.match(line, text, code);
    assert.ok(!line.includes(code), `código cru no /status: ${code}`);
  }
  assert.match(statusCmd.formatTtsStatusLine({ initialized: false, enabled: false, reason: 'qualquer-coisa' }), /motivo desconhecido/);
  const on = statusCmd.formatTtsStatusLine({
    initialized: true, enabled: true,
    engine: { providers: [{ name: 'sapi', probe: { ok: true, detail: 'segredo-do-probe' }, breaker: { state: 'closed' }, lastError: 'ERRO-SECRETO' }] },
    output: { count: 1, speaking: 1, queued: 0, guilds: [{ guildId: 'GUILD-SECRETO', userId: 'USUARIO-SECRETO' }] },
    counters: { spoken: 7, skipped: { 'tts-off': 2, banned: 1 } },
  });
  assert.match(on, /ativa/);
  assert.match(on, /sapi/);
  assert.match(on, /7 falas/);
  assert.match(on, /3 recusadas/);
  for (const secret of ['GUILD-SECRETO', 'USUARIO-SECRETO', 'ERRO-SECRETO', 'segredo-do-probe']) assert.ok(!on.includes(secret), secret);
  assert.match(statusCmd.formatTtsStatusLine({ initialized: true, enabled: true, engine: { providers: [{ name: 'sapi', probe: { ok: true }, breaker: { state: 'open' } }] } }), /em pausa/);
  assert.match(statusCmd.formatTtsStatusLine(null), /desligada/);
  // Estado real do módulo (desligado nesta altura): a linha sai sem lançar.
  await tts.shutdownTts();
  assert.match(statusCmd.formatTtsStatusLine(tts.getTtsStatus()), /desligada/);
});

await test('painel web (integrations): o item "Voz: fala (TTS)" reflete o serviço de TTS (não a chave do Gemini, que a fala local nem usa)', async () => {
  const tts = (data, env = {}) => integrations.buildIntegrations({ env, data }).groups.flatMap((g) => g.items).find((i) => i.key === 'tts');
  // antes: 'ok' só com chave do Gemini e "precisa de chave Gemini" sem ela
  assert.equal(tts({}, { GEMINI_API_KEY: 'x'.repeat(30) }).status, 'off', 'chave do Gemini não significa nada para a fala local');
  assert.equal(tts({ tts: { initialized: false, enabled: false, reason: 'not-initialized' } }).status, 'off');
  assert.match(tts({ tts: { initialized: false, enabled: false, reason: 'not-initialized' } }).detail, /ainda não iniciou/);
  assert.equal(tts({ tts: { initialized: false, enabled: false, reason: 'disabled' } }).status, 'off', 'desligada de propósito');
  for (const reason of ['no-opus', 'no-providers', 'init-error']) {
    const i = tts({ tts: { initialized: false, enabled: false, reason } });
    assert.equal(i.status, 'missing', reason);
    assert.ok(!i.detail.includes(reason), 'o código interno não aparece');
  }
  const ready = { initialized: true, enabled: true, engine: { providers: [{ name: 'sapi', breaker: { state: 'closed' }, probe: { ok: true } }] } };
  const ok = tts({ tts: ready });
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /sapi/);
  assert.match(ok.detail, /sem chave/);
  assert.equal(tts({ tts: { ...ready, engine: { providers: [{ name: 'sapi', breaker: { state: 'open' } }] } } }).status, 'missing', 'provedor em pausa: precisa de atenção');
  assert.equal(tts({ tts: { ...ready, engine: { providers: [{ name: 'sapi', probe: { ok: false } }] } } }).status, 'missing');
  // nunca vaza nada além de contagens e nomes simples
  assert.ok(!/g1|u1/.test(JSON.stringify(tts({ tts: ready }))));
  // loadIntegrationData traz o estado do serviço (aqui desligado)
  const data = await integrations.loadIntegrationData();
  assert.equal(typeof data.tts?.initialized, 'boolean');
});

await test('nenhum resto do TTS antigo: ttsService.js removido e ninguém mais referencia synthesizeSpeech/ttsService em src/', async () => {
  assert.ok(!fs.existsSync(file('src/services/ttsService.js')), 'o arquivo legado foi apagado');
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs|json)$/.test(ent.name) && /synthesizeSpeech|ttsService|speechPlayers|speechQueue/.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(repoRoot, full));
      }
    }
  };
  walk(file('src'));
  walk(file('scripts'));
  assert.deepEqual(hits, []);
  assert.ok(source('tests/test-voice-robust.js').includes('o ttsService.js legado foi apagado'), 'a suíte de robustez da voz exige o serviço novo (não aceita mais o import legado)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
section('Importar services/tts/* não deixa efeito colateral');

await test('importar todos os módulos de services/tts/* num processo limpo não abre handle, processo, timer, pasta nem banco', async () => {
  const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ttsimp-'));
  try {
    const mods = ['config', 'normalize', 'segment', 'audio', 'policy', 'engine', 'output', 'index', 'voiceGuards', 'providers/fake', 'providers/sapi'];
    const code = [
      "import fs from 'node:fs';",
      `const mods = ${JSON.stringify(mods.map((m) => fileUrl(`src/services/tts/${m}.js`)))};`,
      'for (const m of mods) await import(m);',
      'await new Promise((r) => setImmediate(r));',
      "const ignore = new Set(['CloseReq', 'FSReqCallback', 'TTYWrap', 'PipeWrap', 'FileHandle', 'ProcessWrap']);",
      'const active = process.getActiveResourcesInfo().filter((x) => !ignore.has(x));',
      "const has = (n) => fs.existsSync(n);",
      "console.log(JSON.stringify({ active, logs: has('logs'), database: has('database'), secrets: has('secrets'), files: fs.readdirSync('.') }));",
    ].join('\n');
    const started = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: childCwd, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    assert.equal(r.error, undefined, `o processo filho terminou sozinho (${r.error?.message})`);
    assert.equal(r.status, 0, `saída ${r.status}: ${String(r.stderr).slice(0, 300)}`);
    assert.ok(Date.now() - started < 30_000);
    const info = JSON.parse(r.stdout.trim().split('\n').pop());
    const bad = info.active.filter((x) => /Timeout|Immediate|Process|TCP|UDP|Server|Watch|Signal/i.test(x));
    assert.deepEqual(bad, [], `handles abertos: ${info.active.join(',')}`);
    assert.equal(info.logs, false, 'não cria a pasta de logs');
    assert.equal(info.database, false, 'não abre banco');
    assert.equal(info.secrets, false);
    assert.deepEqual(info.files, [], 'nenhum arquivo criado no diretório de trabalho');
  } finally {
    fs.rmSync(childCwd, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
await tick(20);
await test('nada escapou como exceção não tratada ou promessa rejeitada durante os testes', async () => {
  assert.deepEqual(escaped, []);
});

await tts.shutdownTts();
console.log(`\n${passed} testes OK${failed ? `, ${failed} FALHARAM:\n  - ${failures.join('\n  - ')}` : ''}`);

// O llmHandler deixa timers do bot ativos: encerra de forma explícita (e limpa a pasta temporária).
try {
  process.chdir(repoRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* a limpeza é só higiene */ }
process.exit(failed ? 1 : 0);
