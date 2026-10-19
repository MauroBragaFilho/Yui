// Teste ponta a ponta do TTS (a Yui falando na call), SEM Discord e SEM rede.
//
// O que liga (tudo REAL, exceto o que está listado como falso):
//   fala humana (voz Maria do SAPI -> Opus) -> VoiceReceiver REAL do @discordjs/voice -> voiceHandler REAL (captura, anti-eco, STT)
//   -> addToQueue / llmHandler REAL -> chat + [TTS-HOOK] -> services/tts REAL (SAPI REAL) -> output.js REAL
//   -> AudioPlayer REAL -> VoiceConnection REAL.
// Falsos: o gateway do Discord (adapter), o "networking" UDP (sumidouro que captura os pacotes Opus que a Yui envia), a IA local e o STT
// (axios.post interceptado), os objetos de servidor/canal/membro e o cliente (discord.js REAL, sem login, com caches preenchidos à mão).
// Isolamento: DATABASE_DIR e cwd temporários; rede/DNS bloqueados; qualquer escrita DENTRO do projeto é engolida (server_tools.json,
// bans.json, radio_*.json...); no fim os logs são auditados (os marcadores QWERTYZ/RESPOSTAZ de fala nunca podem aparecer).
// Requisitos: Windows, powershell.exe e a voz pt-BR do SAPI (sem isso o teste é PULADO, saída 0). Roda em TEMPO REAL:
// modo rápido ~3 min (13 cenários + a auditoria final), --full ~15 min (todos: 48 cenários + a auditoria).
// O TTS sobe pelo caminho de PRODUÇÃO (initTts sem gerenciador injetado): foi assim que se achou o bug em que a Yui respondia no chat
// e nunca falava (registro de conexões duplicado entre o @discordjs/voice ESM e o CJS). Nada aqui injeta a conexão.
// Nada sai da máquina; escritas dentro do projeto são engolidas. Os cenários de ferramenta usam só JSON que o guarda de voz recusa.
// Uso: node tests/test-tts-e2e.js [--full] [S1 S8 ...]      (npm run test:tts-e2e [-- --full])
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  fs.writeSync(1, 'test-tts-e2e: pulado (o SAPI só existe no Windows)\n');
  process.exit(0);
}

const ROOT = process.env.YUI_E2E_ROOT ? path.resolve(process.env.YUI_E2E_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_LOWER = path.resolve(ROOT).toLowerCase();
const U = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const activity = { n: 0 };
const requireFromProject = createRequire(path.join(ROOT, 'package.json'));

// ── saída própria (o stdout é capturado para auditar vazamento) ─────────────────────────────────────
const say = (s = '') => fs.writeSync(1, `${s}\n`);

// ── ambiente isolado ────────────────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-e2e-'));
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
  LOG_LEVEL: 'info',
  GROQ_API_KEY: 'chave-falsa-do-harness-0000', // só para o STT montar a cadeia; a chamada é interceptada
});
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'YUI_REPLY_MAX_TOKENS',
  'YUI_REPLY_MAX_PARTS', 'YUI_CONTEXT_ENABLED', 'YUI_CONTEXT_SCOPE', 'YUI_VOICE_TOOLS', 'YUI_PERSONA_VOICE_FILE',
  'YUI_TTS_STALE_SECONDS', 'WITAI_TOKEN', 'WIT_AI_KEY', 'OPENAI_API_KEY', 'OPENAI_STT_KEY', 'LOCAL_STT_URL', 'WHISPER_LOCAL_URL',
  'GEMINI_MODEL_FALLBACK', 'DISCORD_TOKEN', 'YUI_TTS_ENABLED', 'YUI_TTS_PROVIDERS']) {
  if (k !== 'GROQ_API_KEY') delete process.env[k];
}
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

// ── captura de console/stdout para a auditoria de privacidade ───────────────────────────────────────
const captured = { console: [], stdout: [] };
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { captured.stdout.push(String(chunk)); const cb = rest.find((x) => typeof x === 'function'); cb?.(); return true; };
process.stderr.write = (chunk, ...rest) => { captured.stdout.push(String(chunk)); const cb = rest.find((x) => typeof x === 'function'); cb?.(); return true; };
for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  console[m] = (...a) => { captured.console.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); };
}

// ── erros que escapam ───────────────────────────────────────────────────────────────────────────────
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(`uncaughtException: ${e?.code || e?.name}: ${String(e?.message).slice(0, 120)}`));
process.on('unhandledRejection', (e) => escaped.push(`unhandledRejection: ${e?.code || e?.name}: ${String(e?.message ?? e).slice(0, 120)}`));

// ── nada sai da máquina; nada é escrito dentro do projeto ──────────────────────────────────────────
const swallowedWrites = [];
const insideProject = (file) => {
  try { return path.resolve(String(file)).toLowerCase().startsWith(ROOT_LOWER); } catch { return false; }
};
for (const name of ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'unlinkSync', 'rmSync', 'mkdirSync']) {
  const orig = fs[name];
  fs[name] = function guarded(file, ...rest) {
    if (insideProject(file)) { swallowedWrites.push(`${name}:${path.basename(String(file))}`); return undefined; }
    return orig.call(this, file, ...rest);
  };
}
for (const name of ['writeFile', 'appendFile']) {
  const orig = fs[name];
  fs[name] = function guarded(file, ...rest) {
    if (insideProject(file)) {
      swallowedWrites.push(`${name}:${path.basename(String(file))}`);
      const cb = rest.find((x) => typeof x === 'function');
      if (cb) cb(null);
      return undefined;
    }
    return orig.call(this, file, ...rest);
  };
}
for (const name of ['writeFile', 'appendFile', 'rm', 'unlink', 'rename']) {
  const orig = fs.promises[name];
  fs.promises[name] = async function guarded(file, ...rest) {
    if (insideProject(file)) { swallowedWrites.push(`promises.${name}:${path.basename(String(file))}`); return undefined; }
    return orig.call(this, file, ...rest);
  };
}
syncBuiltinESMExports();

net.Socket.prototype.connect = function blocked() { throw new Error('rede bloqueada no harness'); };
dns.promises.lookup = async () => { const e = new Error('ENOTFOUND (harness)'); e.code = 'ENOTFOUND'; throw e; };
dns.lookup = (h, o, cb) => { const e = new Error('ENOTFOUND (harness)'); e.code = 'ENOTFOUND'; (typeof o === 'function' ? o : cb)(e); };
globalThis.fetch = async (url) => { throw new Error(`fetch bloqueado no harness: ${String(url).slice(0, 40)}`); };

// ── axios: IA local falsa, STT falso, o resto falha ────────────────────────────────────────────────
const axios = (await import(U('node_modules/axios/index.js'))).default;
const net_calls = []; // { method, url }
const stt = { queue: [], calls: 0, fallbackText: '', lastAt: 0 };
const llmState = { script: null, delayMs: 0, calls: [], lastAt: 0, down: false };
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

function sse(text, finish = 'stop', model = 'modelo-falso') {
  const chunks = [];
  const n = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += n) chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: { content: text.slice(i, i + n) }, finish_reason: null }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return Readable.from(chunks);
}
let localLlmUrl = null; // preenchido depois de importar a config
axios.post = async (url, body, cfg) => {
  net_calls.push({ method: 'post', url: String(url) });
  if (String(url) === GROQ_URL) {
    stt.calls += 1;
    stt.lastAt = Date.now();
    const text = stt.queue.length ? stt.queue.shift() : stt.fallbackText;
    return { data: { text } };
  }
  if (localLlmUrl && String(url) === localLlmUrl) {
    llmState.lastAt = Date.now();
    llmState.calls.push(body);
    if (llmState.down) throw new Error('IA local fora do ar (harness)');
    if (llmState.delayMs > 0) await sleep(llmState.delayMs);
    const out = typeof llmState.script === 'function' ? llmState.script(body) : llmState.script;
    const text = typeof out === 'string' ? out : out?.text ?? 'Resposta padrão do harness.';
    return { data: sse(text, out?.finish ?? 'stop') };
  }
  throw new Error('offline (harness)');
};
axios.get = async (url) => { net_calls.push({ method: 'get', url: String(url) }); throw new Error('offline (harness)'); };

// ── módulos do projeto (caminhos absolutos; mesmas instâncias que o bot usa) ───────────────────────
const voiceEsm = await import(U('node_modules/@discordjs/voice/dist/index.mjs')); // o MESMO arquivo que o voiceHandler.js resolve
const { default: config } = await import(U('src/config/index.js'));
config.saveHistory = false;
localLlmUrl = config.localLlmUrl;
const discordJs = await import(U('node_modules/discord.js/src/index.js'));
const llm = await import(U('src/handlers/llmHandler.js'));
const voice = await import(U('src/handlers/voiceHandler.js'));
const tts = await import(U('src/services/tts/index.js'));
const panel = await import(U('src/handlers/mcpToolPanelHandler.js'));
const sapiMod = await import(U('src/services/tts/providers/sapi.js'));
const fakeProv = await import(U('src/services/tts/providers/fake.js'));
const ban = await import(U('src/handlers/banHandler.js'));
const radioDb = await import(U('src/music/radioDatabase.js'));
const radioMgr = await import(U('src/music/radioManager.js'));
const clientMod = await import(U('src/discord/client.js'));
const persona = await import(U('src/core/persona.js'));
const guards = await import(U('src/services/tts/voiceGuards.js'));
const statusCmd = await import(U('src/discord/commands/status.js'));
const binaries = await import(U('src/utils/binaries.js'));
const OpusScript = requireFromProject('opusscript');
const core = await import(U('src/core/index.js'));
await core.initMemory();

// ── Servidor/canal/membro falsos ────────────────────────────────────────────────────────────────────
class FakeMessage {
  constructor(channel, payload) {
    this.channel = channel;
    this.id = `m${channel.sent.length + 1}`;
    this.content = typeof payload === 'string' ? payload : payload?.content ?? '';
    this.payload = payload;
    this.createdAt = Date.now();
    this.versions = [{ at: this.createdAt, content: this.content }];
  }
  async edit(payload) {
    activity.n += 1;
    this.content = typeof payload === 'string' ? payload : payload?.content ?? this.content;
    this.versions.push({ at: Date.now(), content: this.content });
    this.channel.lastEditAt = Date.now();
    return this;
  }
  async delete() { this.deleted = true; return this; }
}

class FakeTextChannel {
  constructor(guild, id = 'text1') {
    this.guild = guild;
    this.id = id;
    this.name = 'geral';
    this.type = 0;
    this.sent = [];
    this.lastEditAt = 0;
  }
  async send(payload) {
    const m = new FakeMessage(this, payload);
    activity.n += 1;
    this.sent.push(m);
    return m;
  }
  /** Textos "finais" que o usuário viu (última versão de cada mensagem). */
  texts() { return this.sent.map((m) => m.content); }
  allVersions() { return this.sent.flatMap((m) => m.versions.map((v) => v.content)); }
}

function makeMember(client, guild, voiceChannel, { id, bot = false, name = `u${id}`, inVoice = true } = {}) {
  const member = {
    id,
    client,
    guild,
    displayName: name,
    user: { id, bot, username: name, tag: `${name}#0001`, globalName: name },
    voice: { channelId: inVoice ? voiceChannel.id : null, selfMute: false, serverMute: false, channel: inVoice ? voiceChannel : null },
  };
  guild.members.cache.set(id, member);
  if (inVoice) voiceChannel.members.set(id, member);
  return member;
}

function moveOutOfVoice(member) {
  member.voice.channelId = null;
  member.voice.channel = null;
  member.guild.channels.cache.get(member.guild.voiceId)?.members.delete(member.id);
}

let guildSeq = 0;
/** Cria um servidor completo (voz + texto + membros) dentro do cliente discord.js. */
function makeGuild(client, { id = `G${++guildSeq}`, humans = ['201', '202'], bots = ['900'], stage = false } = {}) {
  const Col = client.guilds.cache.constructor; // Collection do discord.js (tem filter/size como o real)
  const guild = {
    id,
    name: `Servidor ${id}`,
    client,
    members: { cache: new Col(), me: null },
    channels: { cache: new Col() },
    roles: { cache: new Col() },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  };
  const voiceChannel = {
    id: `vc-${id}`,
    name: 'Call',
    type: stage ? 13 : 2,
    guild,
    members: new Col(),
    permissionsFor: () => ({ has: () => true }),
  };
  guild.voiceId = voiceChannel.id;
  const text = new FakeTextChannel(guild, `text-${id}`);
  guild.channels.cache.set(voiceChannel.id, voiceChannel);
  guild.channels.cache.set(text.id, text);
  client.guilds.cache.set(id, guild);
  client.channels.cache.set(voiceChannel.id, voiceChannel);
  client.channels.cache.set(text.id, text);
  const me = makeMember(client, guild, voiceChannel, { id: '999', name: 'Yui', inVoice: false });
  me.voice = { channelId: null, serverMute: false, suppress: false, selfMute: false, disconnect: async () => { me.voice.channelId = null; } };
  guild.members.me = me;
  const members = {};
  for (const h of humans) members[h] = makeMember(client, guild, voiceChannel, { id: h, name: `Humano${h}` });
  for (const b of bots) members[b] = makeMember(client, guild, voiceChannel, { id: b, bot: true, name: `Bot${b}` });
  return { guild, voiceChannel, text, members, id };
}

// ── "networking" falso: o sumidouro dos pacotes Opus que o AudioPlayer REAL manda ao VoiceConnection REAL ──
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
class NetStub {
  constructor(label) {
    this.label = label;
    this.state = { code: 4, connectionData: {} }; // 4 = Ready
    this.packets = []; // { t, pkt, silent }
    this.prepared = undefined;
    this.speakingFlags = []; // { t, v }
  }
  on() { return this; }
  off() { return this; }
  once() { return this; }
  destroy() {}
  prepareAudioPacket(buf) { this.prepared = buf; return buf; }
  dispatchAudio() {
    if (this.prepared === undefined) return false;
    const pkt = Buffer.from(this.prepared);
    this.prepared = undefined;
    const silent = pkt.compare(SILENCE_FRAME) === 0;
    if (!silent) activity.n += 1;
    this.packets.push({ t: performance.now(), wall: Date.now(), pkt, silent });
    return true;
  }
  setSpeaking(v) { this.speakingFlags.push({ t: performance.now(), v: Boolean(v) }); }
}

/** Força uma VoiceConnection REAL (Signalling) a ficar Ready, com o networking falso como sumidouro. */
function forceReady(conn, label) {
  const netStub = new NetStub(label);
  conn.state = { status: 'ready', adapter: conn.state.adapter, networking: netStub };
  conn.__net = netStub;
  return netStub;
}

/** Analisa o que a Yui "falou" numa conexão: pacotes de voz (não silêncio), duração, RMS, primeiro som. */
function analyzeAudio(netStub, sinceWall = 0) {
  const voiced = netStub.packets.filter((p) => !p.silent && p.wall >= sinceWall);
  if (!voiced.length) return { packets: 0, speechMs: 0, firstWall: null, lastWall: null, rms: 0, spanMs: 0 };
  const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  let sum = 0;
  let n = 0;
  for (const p of voiced) {
    const pcm = Buffer.from(dec.decode(p.pkt));
    for (let i = 0; i + 1 < pcm.length; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; n += 1; }
  }
  try { dec.delete(); } catch { /* ignora */ }
  return {
    packets: voiced.length,
    speechMs: voiced.length * 20,
    firstWall: voiced[0].wall,
    lastWall: voiced.at(-1).wall,
    spanMs: voiced.at(-1).wall - voiced[0].wall,
    rms: Math.round(Math.sqrt(sum / Math.max(1, n))),
  };
}

// ── fala humana: PCM da voz Maria (SAPI real), codificado em Opus e empurrado no receiver REAL ──────
let humanPcmCache = null;
async function humanPcm() {
  if (humanPcmCache) return humanPcmCache;
  const p = sapiMod.createSapiProvider({ config: { ...(await import(U('src/services/tts/config.js'))).getTtsConfig(), sapiVoice: '' }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  try {
    const r = await p.synth('Yui, qual é a capital da Austrália? Eu gostaria de saber qual é a capital, por favor, e também a população dessa cidade.');
    humanPcmCache = r.pcm;
  } catch {
    // sem SAPI: onda com variação suficiente para passar do RMS mínimo do voiceHandler
    const n = 48000 * 8 * 2;
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 2) { const v = Math.round(9000 * Math.sin((i / 2) * 0.03) * Math.sin((i / 2) * 0.0007)); b.writeInt16LE(v, i * 2); b.writeInt16LE(v, i * 2 + 2); }
    humanPcmCache = b;
  } finally {
    await p.dispose();
  }
  return humanPcmCache;
}

/**
 * Faz `userId` falar por `ms` milissegundos no receiver da conexão ATUAL do servidor (tempo real, 1 pacote Opus a cada 20 ms),
 * como o Discord entrega: speaking.start no 1º pacote, speaking.end 100 ms depois do último. Devolve { startedAt, endedAt }.
 * Os pacotes que chegam antes de existir assinatura são descartados (como no VoiceReceiver real).
 */
async function humanSpeak(guildId, userId, ms = 1500, { offsetMs = 0 } = {}) {
  const conn = voiceEsm.getVoiceConnection(guildId);
  if (!conn) throw new Error('sem conexão para falar (harness)');
  const recv = conn.receiver;
  const pcm = await humanPcm();
  const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const frames = Math.ceil(ms / 20);
  const total = Math.floor(pcm.length / 3840);
  const startedAt = Date.now();
  let cursor = Math.floor((offsetMs / 20)) % Math.max(1, total);
  for (let i = 0; i < frames; i += 1) {
    const off = ((cursor + i) % total) * 3840;
    const frame = pcm.subarray(off, off + 3840);
    recv.speaking.onPacket(userId);
    const stream = recv.subscriptions.get(userId);
    if (stream && !stream.destroyed) stream.push(Buffer.from(enc.encode(frame, 960)));
    await sleep(20);
  }
  try { enc.delete(); } catch { /* ignora */ }
  return { startedAt, endedAt: Date.now() };
}

// ── ponte com o bot: entrar na call, ligar o interruptor, banco de logs ─────────────────────────────
const ttsLogs = [];
const ttsLogger = {
  info: (m) => ttsLogs.push(['info', String(m), Date.now()]),
  warn: (m) => ttsLogs.push(['warn', String(m), Date.now()]),
  error: (m) => ttsLogs.push(['error', String(m), Date.now()]),
  debug: () => {},
};
const ttsLogsFor = (guildId) => ttsLogs.filter(([, m]) => m.includes(`servidor=${guildId}`) || m.includes(`servidor ${guildId}`)).map(([l, m]) => `${l}: ${m}`);

async function waitUntil(pred, ms = 15000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (pred()) return true; } catch { /* continua */ }
    await sleep(step);
  }
  try { return Boolean(pred()); } catch { return false; }
}

/** joinVoiceCall REAL; a conexão (Signalling) é forçada a Ready com o networking falso. */
async function joinCall(rig, member) {
  const guildId = rig.guild.id;
  llm.setServerToolEnabled(guildId, 'join_voice_call', true);
  llm.setServerToolEnabled(guildId, 'leave_voice_call', true);
  const p = voice.joinVoiceCall(member, rig.text);
  await waitUntil(() => voiceEsm.getVoiceConnection(guildId), 5000, 5);
  const conn = voiceEsm.getVoiceConnection(guildId);
  if (!conn) { await p.catch(() => {}); throw new Error('joinVoiceCall não criou conexão'); }
  forceReady(conn, guildId);
  rig.guild.members.me.voice.channelId = rig.voiceChannel.id; // o "gateway" confirmou a entrada
  const ok = await p;
  return { ok, conn };
}

function isoNow() { return new Date().toISOString().slice(11, 23); }

// Montagem do mundo (cliente discord.js REAL com caches falsos, TTS de produção ou com a correção do registro de conexões)
// e utilitários para os cenários.


const results = [];
let current = null;

function scenario(id, title, expected) {
  current = { id, title, expected, checks: [], notes: [], error: null };
  results.push(current);
  return current;
}
function check(cond, text) {
  current.checks.push({ ok: Boolean(cond), text });
  return Boolean(cond);
}
function note(text) { current.notes.push(text); }
function fail(err) { current.error = String(err?.stack ?? err).split('\n').slice(0, 6).join(' | '); }
function status(r) {
  if (r.error) return 'FALHA-DO-HARNESS';
  return r.checks.every((c) => c.ok) ? 'CONFERE' : 'DESVIO';
}

// ── cliente REAL do discord.js (sem login) com o 'ready' REAL do bootstrap ────────────────────────
function makeClient() {
  const client = L.clientMod.createDiscordClient();
  client.user = { id: '999', tag: 'Yui#0001', setPresence() {}, setActivity() {} };
  return client;
}

/**
 * Sobe o TTS como o bootstrap sobe (deps reais de createTtsDeps), SEM gerenciador de saída injetado: é o caminho de produção de
 * src/services/tts/index.js (o initTts monta o gerenciador com o mesmo @discordjs/voice que o voiceHandler usa).
 */
async function startTts(client, { cfg: cfgOv = {}, providers, opus = true, extraDeps = {}, logger = L.ttsLogger } = {}) {
  await L.tts.shutdownTts();
  const deps = {
    ...L.voice.createTtsDeps(client, {
      isToolDisabled: L.llm.isToolDisabled,
      getAllMcpTools: L.llm.getAllMcpTools,
      checkBan: L.ban.checkBan,
      forbiddenKeywords: L.ban.forbiddenKeywords,
      hasActiveSession: L.radioDb.hasActiveSession,
      isOpusAvailable: opus ? L.binaries.isOpusAvailable : () => false,
    }),
    ...extraDeps,
  };
  const overrides = { logger, config: cfgOv };
  if (providers) overrides.providers = providers;
  return L.tts.initTts({ client, deps, overrides });
}

function ttsCounters() {
  const s = L.tts.getTtsStatus();
  return { requests: s.counters?.requests ?? 0, accepted: s.counters?.accepted ?? 0, spoken: s.counters?.spoken ?? 0, skipped: { ...(s.counters?.skipped ?? {}) }, finished: { ...(s.counters?.finished ?? {}) }, interrupts: s.counters?.interrupts ?? 0 };
}
const skippedCount = (reason) => ttsCounters().skipped[reason] || 0;
const finishedCount = (reason) => ttsCounters().finished[reason] || 0;

// ── cenário completo: entra na call, liga o interruptor, ... ───────────────────────────────────────
async function newRig(client, { ttsOn = true, humans, bots, stage = false, join = true, warm = true } = {}) {
  const rig = L.makeGuild(client, { humans, bots, stage });
  rig.author = rig.members['201'] ?? Object.values(rig.members).find((m) => !m.user.bot);
  if (ttsOn) L.llm.setServerToolEnabled(rig.id, 'voice_tts', true);
  if (join) {
    const j = await L.joinCall(rig, rig.author);
    rig.conn = j.conn;
    rig.net = j.conn.__net;
    rig.joined = j.ok;
    if (warm && ttsOn) await L.tts.warmupTts();
  }
  return rig;
}

function setLlm(script, delayMs = 0) {
  L.llmState.script = script;
  L.llmState.delayMs = delayMs;
  L.llmState.calls.length = 0;
}

/** Texto final que o usuário vê no chat (última versão da última mensagem com texto de resposta, sem "Processando"). */
function chatAnswers(rig) {
  return rig.text.sent.map((m) => m.content).filter((c) => c && !c.includes('Processando'));
}

function audioSince(rig, sinceWall) { return L.analyzeAudio(rig.conn.__net, sinceWall); }

/** Fala como `userId` (STT devolve `transcript`) e espera o pipeline assentar. */
async function utter(rig, userId, transcript, { ms = 1400 } = {}) {
  L.stt.queue.push(transcript);
  return L.humanSpeak(rig.id, userId, ms);
}

async function settle(ms = 2500, { guard = 60000 } = {}) {
  // espera "silêncio" de atividade: STT, IA, texto no chat e pacotes de áudio parados por `ms`
  const t0 = Date.now();
  let last = Date.now();
  let snap = '';
  while (Date.now() - t0 < guard) {
    const s = `${L.stt.calls}|${L.llmState.calls.length}|${L.ttsLogs.length}|${L.captured.stdout.length}|${L.activity.n}`;
    if (s !== snap) { snap = s; last = Date.now(); }
    if (Date.now() - last >= ms) return true;
    await sleep(100);
  }
  return false;
}


const wallNow = () => Date.now();

// ── provedor-espião: envolve o SAPI REAL, anota o texto que chega à síntese e permite atraso/falha ──
async function makeRealSapi(cfgOv = {}) {
  const { getTtsConfig } = await import(L.U('src/services/tts/config.js'));
  return L.sapiMod.createSapiProvider({ config: { ...getTtsConfig(), ...cfgOv }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
}
function makeSpyProvider(real) {
  const spy = { texts: [], delayMs: 0, failWith: null, calls: 0 };
  const provider = {
    name: 'sapi',
    local: true,
    spy,
    probe: () => real.probe(),
    warmup: () => real.warmup(),
    async synth(text, opts = {}) {
      spy.calls += 1;
      spy.texts.push(String(text));
      if (spy.failWith) { const e = new Error('falha simulada'); e.code = spy.failWith; throw e; }
      if (spy.delayMs > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, spy.delayMs);
          opts.signal?.addEventListener?.('abort', () => { clearTimeout(t); const e = new Error('abortado'); e.code = 'ABORTED'; reject(e); }, { once: true });
        });
      }
      return real.synth(text, opts);
    },
    dispose: async () => {}, // quem encerra o SAPI real é o harness (o helper fica quente entre os cenários)
    isWarm: () => real.isWarm?.() ?? false,
  };
  return provider;
}

// ── leitura dos logs do TTS por servidor ────────────────────────────────────────────────────────────
function parseFala(line) {
  const kv = {};
  for (const m of line.matchAll(/(\w+)=(\S+)/g)) kv[m[1]] = m[2];
  return kv;
}
function falas(rig) {
  return L.ttsLogs.filter(([, m]) => m.startsWith('[TTS] Fala: ') && m.includes(`servidor=${rig.id} `)).map(([, m]) => parseFala(m));
}
function semFala(rig) {
  return L.ttsLogs.filter(([, m]) => m.startsWith('[TTS] Sem fala: ') && m.includes(`servidor=${rig.id} `)).map(([, m]) => parseFala(m));
}
function chatFor(rig, userId) {
  const m = rig.text.sent.filter((x) => x.content.startsWith(`<@${userId}>`) && !x.content.includes('Processando') && !/est[áa] na fila/i.test(x.content)).at(-1);
  return m ? { content: m.content, finalAt: m.versions.at(-1).at, firstAt: m.versions[0].at } : null;
}
function allChatFor(rig, userId) {
  return rig.text.sent.filter((x) => x.content.startsWith(`<@${userId}>`) && !x.content.includes('Processando') && !/est[áa] na fila/i.test(x.content)).map((m) => ({ content: m.content, finalAt: m.versions.at(-1).at }));
}

async function awaitOutcome(before, ms = 45000) {
  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const ok1 = await waitUntil(() => ttsCounters().requests > before.requests, ms);
  if (!ok1) return { requested: false };
  const ok2 = await waitUntil(() => {
    const c = ttsCounters();
    return total(c.skipped) > total(before.skipped) || total(c.finished) > total(before.finished);
  }, ms);
  return { requested: true, finished: ok2 };
}


// ── espaços de nomes usados pelos cenários ──────────────────────────────────────────────────────────
const L = { ROOT, U, sleep, activity, say, tmp, captured, escaped, swallowedWrites, net_calls, stt, llmState, voiceEsm, config, discordJs, llm, voice, tts, panel, sapiMod, fakeProv, ban, radioDb, radioMgr, clientMod, persona, guards, statusCmd, binaries, OpusScript, FakeMessage, FakeTextChannel, makeMember, moveOutOfVoice, makeGuild, NetStub, forceReady, analyzeAudio, humanPcm, humanSpeak, ttsLogs, ttsLogger, ttsLogsFor, waitUntil, joinCall };
const D = { results, scenario, check, note, fail, status, makeClient, startTts, ttsCounters, skippedCount, finishedCount, newRig, setLlm, chatAnswers, audioSince, utter, settle, makeRealSapi, makeSpyProvider, parseFala, falas, semFala, chatFor, allChatFor, awaitOutcome };

// Cenários ponta a ponta. Cada um monta seu próprio servidor falso, fala por um receiver REAL e observa chat, áudio (pacotes Opus
// capturados), logs do TTS e contadores. Execução: node scenarios.mjs [filtro-de-ids]




const args = process.argv.slice(2);
const FULL = args.includes('--full');
const only = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
// modo rápido (~3 min): os cenários que cobrem o fluxo inteiro e as regressões já vistas; --full roda todos (~15 min, tempo real)
const QUICK = new Set(['S0', 'S1', 'S2', 'S3A', 'S7', 'S8', 'S9', 'S10B', 'S12B', 'S13A', 'S14', 'S16', 'S17']);
const want = (id) => (only.length ? only.includes(id.toUpperCase()) : FULL || QUICK.has(id.toUpperCase()));

const client = D.makeClient();
const realSapi = await D.makeRealSapi();
const spy = D.makeSpyProvider(realSapi);
{
  const pr = await realSapi.probe();
  if (!pr.ok) { say(`test-tts-e2e: pulado (sem voz pt-BR do SAPI: ${pr.detail})`); await realSapi.dispose(); process.exit(0); }
}
const VOICE_TEXT = L.persona.voicePersonaText();
const MARK = (s) => s; // marcadores únicos nos textos (auditoria de privacidade no fim)

// Tem texto de ferramentas no prompt de sistema? (a oferta aparece como "search_web" e companhia)
const hasToolsText = (sys) => /search_web|download_audio|search_and_download_music/.test(sys);
const sysOf = (body) => body?.messages?.[0]?.content ?? '';
const lastUser = (body) => body?.messages?.at(-1)?.content ?? '';

async function cleanup(rig) {
  L.stt.queue.length = 0;
  try { await L.voice.leaveVoiceCall(rig.id, null); } catch { /* ignora */ }
  try { L.radioDb.destroySession(rig.id); } catch { /* ignora */ }
  try { L.llm.clearVoiceHistory(rig.id); } catch { /* ignora */ }
  spy.spy.texts.length = 0;
  spy.spy.delayMs = 0;
  spy.spy.failWith = null;
}

async function run(id, title, expected, fn, { tts: ttsOpts = null } = {}) {
  if (!want(id)) return;
  const r = scenario(id, title, expected);
  const t0 = Date.now();
  say(`\n[${id}] ${title}`);
  try {
    if (ttsOpts) await D.startTts(client, { providers: [spy], ...ttsOpts });
    await fn(r);
  } catch (err) {
    D.fail(err);
    say(`   ERRO DO HARNESS: ${r.error}`);
  }
  const st = D.status(r);
  say(`   => ${st} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const c of r.checks) say(`      ${c.ok ? 'ok  ' : 'XX  '}${c.text}`);
  for (const n of r.notes) say(`      obs ${n}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// S0: bootstrap REAL (client.once('ready') -> initTts de produção) e a fala de ponta a ponta com a fiação de PRODUÇÃO
// ════════════════════════════════════════════════════════════════════════════════════════════════
await run('S0', 'Boot real: ready -> initTts (fiação de produção) e uma pergunta por voz', 'a Yui responde no chat E fala (T1 1.6); regressão: antes ela respondia no chat e nunca falava (no-connection)', async (r) => {
  client.emit('ready', client); // o handler REAL de src/discord/client.js
  const up = await waitUntil(() => L.tts.getTtsStatus().initialized, 10000);
  check(up, 'initTts rodou no ready REAL do client.js e o TTS subiu');
  D.setLlm('Canberra, não Sydney.');
  const rig = await D.newRig(client, { ttsOn: true, warm: false });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '201', 'Yui, qual a capital da Austrália?', { ms: 900 });
  await D.awaitOutcome(before);
  await D.settle(1500);
  const a = D.audioSince(rig, t0);
  const c = D.ttsCounters();
  check(D.chatFor(rig, '201')?.content.includes('Canberra'), 'o texto chegou ao chat');
  check(c.accepted === before.accepted + 1, 'a fala foi aceita na fila');
  check(a.packets > 0, `a Yui FALOU (pacotes Opus de voz capturados: ${a.packets}; fim da fila: ${JSON.stringify(c.finished)})`);
  await cleanup(rig);
});

// A partir daqui o provedor de voz é o espião (envolve o SAPI REAL e anota o texto que chega à síntese); a saída segue a fiação de produção.
await D.startTts(client, { providers: [spy], cfg: { globalPerMin: 240 } });

// ════════════════════════════════════════════════════════════════════════════════════════════════
await run('S1', 'Pedido normal por voz', 'texto no chat E fala; persona de voz no fim; sem ferramentas; nada em historico.txt (T1 1.1/1.6, T1b 11/20/22)', async () => {
  D.setLlm(MARK('Canberra RESPOSTAZ1 é a capital, não Sydney.'));
  const rig = await D.newRig(client);
  const before = D.ttsCounters();
  const sttBefore1 = L.stt.calls;
  const t0 = Date.now();
  await D.utter(rig, '201', 'Yui, qual a capital do reino QWERTYZ1?', { ms: 900 });
  const out = await D.awaitOutcome(before);
  await D.settle(1500);
  const a = D.audioSince(rig, t0);
  const body = L.llmState.calls.at(-1);
  const ans = D.chatFor(rig, '201');
  check(L.stt.calls === sttBefore1 + 1 && L.llmState.calls.length === 1, `uma ida ao STT e uma chamada à IA (STT=${L.stt.calls - sttBefore1}, IA=${L.llmState.calls.length})`);
  check(sysOf(body).endsWith(VOICE_TEXT), 'a persona de voz é o ÚLTIMO bloco do prompt de sistema (T1b 10)');
  check(!hasToolsText(sysOf(body)), 'a IA não recebeu a oferta de ferramentas');
  check(ans && ans.content.includes('RESPOSTAZ1'), 'a resposta escrita está no chat com a menção de quem pediu');
  check(out.requested && D.ttsCounters().spoken === before.spoken + 1, 'o gancho pediu a fala e ela terminou');
  check(a.speechMs >= 1500 && a.rms > 1000, `áudio audível capturado (${a.speechMs} ms, RMS ${a.rms})`);
  check(ans && a.firstWall && ans.finalAt <= a.firstWall, 'o texto foi entregue ANTES do primeiro som (T1b 20)');
  const f = D.falas(rig).at(-1);
  check(f && f.motivo === 'done' && Number(f.ms_primeiro_som) < 3000, `log de fala sem conteúdo: motivo=${f?.motivo} ms_primeiro_som=${f?.ms_primeiro_som}`);
  check(spy.spy.texts.length === 1 && !/[{}\[\]@<>]/.test(spy.spy.texts[0]), `a síntese recebeu 1 frase limpa (${spy.spy.texts.length})`);
  check(!L.swallowedWrites.some((w) => /historico/.test(w)), 'nada foi gravado no historico.txt (T1b 22)');
  check(L.llm.clearVoiceHistory(rig.id) >= 1, 'o histórico em RAM da voz existe e clearVoiceHistory(guild) o apaga');
  const statusLine = L.statusCmd.formatTtsStatusLine(L.tts.getTtsStatus());
  check(/ativa/.test(statusLine) && !new RegExp(`${rig.id}|201|RESPOSTAZ|QWERTYZ`).test(statusLine), `linha do /yui-status sem IDs nem texto: ${statusLine}`);
  note(`latência: fim da fala humana -> primeiro som = ${a.firstWall ? a.firstWall - (t0 + 900) : '?'} ms (inclui 1200 ms de silêncio do receiver)`);
  await cleanup(rig);
});

await run('S2', 'Sem o interruptor voice_tts', 'texto no chat e NENHUMA fala; a conversa por voz é a de antes do TTS: sem persona de voz, com as ferramentas oferecidas, sem marcas de voz, sem debounce', async () => {
  D.setLlm('Paris RESPOSTAZ2.');
  const rig = await D.newRig(client, { ttsOn: false });
  const before = D.ttsCounters();
  await D.utter(rig, '201', 'Yui, qual a capital da França QWERTYZ2?', { ms: 900 });
  await D.settle(2500);
  const a = D.audioSince(rig, 0);
  const body = L.llmState.calls.at(-1);
  check(D.chatFor(rig, '201')?.content.includes('RESPOSTAZ2'), 'o texto chegou ao chat');
  check(a.packets === 0 && spy.spy.texts.length === 0, 'nenhuma fala e nada chegou à síntese');
  check(D.ttsCounters().requests === before.requests, 'o serviço de fala nem foi chamado (o pedido não é de voz falada)');
  check(!sysOf(body).endsWith(VOICE_TEXT), 'sem a persona curta de voz');
  check(hasToolsText(sysOf(body)), 'as ferramentas continuam sendo oferecidas (a voz as tinha antes do TTS; só o modo voz as tira)');
  // sem o modo voz também não há debounce: um segundo pedido logo em seguida é atendido (o debounce de 6 s é do modo voz)
  D.setLlm('Roma RESPOSTAZ2b.');
  const llmBefore = L.llmState.calls.length;
  await D.utter(rig, '201', 'Yui, e a capital da Itália QWERTYZ2b?', { ms: 900 });
  await D.settle(2500);
  check(L.llmState.calls.length === llmBefore + 1 && D.allChatFor(rig, '201').some((m) => m.content.includes('RESPOSTAZ2b')), 'o segundo pedido (sem esperar 6 s) também foi atendido');
  await cleanup(rig);
});

await run('S3a', 'Usuário banido fala', 'ignorado antes do STT: sem STT, sem IA, sem chat, sem fala (T1 1.1 item 5, V1)', async () => {
  D.setLlm('Não deveria responder.');
  const rig = await D.newRig(client, { humans: ['201', '203'] });
  L.ban.addBan('user', '203', 'teste do harness');
  const sttBefore = L.stt.calls;
  const llmBefore = L.llmState.calls.length;
  await D.utter(rig, '203', 'Yui, qual a capital QWERTYZ3a?', { ms: 900 });
  await D.settle(2500);
  check(L.stt.calls === sttBefore, `o STT em nuvem nem foi chamado para o banido (${L.stt.calls - sttBefore})`);
  check(L.llmState.calls.length === llmBefore && !D.chatFor(rig, '203'), 'sem IA e sem resposta no chat');
  check(D.audioSince(rig, 0).packets === 0, 'sem fala');
  L.ban.removeBan('user', '203');
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S3b', 'Banido DEPOIS de pedir (durante a IA)', 'o texto já segue o fluxo antigo, mas a fala NÃO sai (decideSpeak banned)', async () => {
  D.setLlm('Resposta lenta RESPOSTAZ3b.', 1800);
  const rig = await D.newRig(client, { humans: ['201', '204'] });
  const before = D.ttsCounters();
  await D.utter(rig, '204', 'Yui, qual a capital QWERTYZ3b?', { ms: 900 });
  await waitUntil(() => L.llmState.calls.length === 1, 8000);
  L.ban.addBan('user', '204', 'teste do harness');
  const out = await D.awaitOutcome(before);
  await D.settle(1500);
  check(D.chatFor(rig, '204')?.content.includes('RESPOSTAZ3b'), 'o texto foi entregue (o ban é checado antes da IA; já tinha passado)');
  check(out.requested && D.skippedCount('banned') > (before.skipped.banned || 0), 'fala recusada: banned');
  check(D.audioSince(rig, 0).packets === 0, 'nenhum som');
  L.ban.removeBan('user', '204');
  await cleanup(rig);
});

await run('S4a', 'Usuário sai do canal de voz antes da resposta', 'texto sim, fala não (user-not-in-call)', async () => {
  D.setLlm('Resposta RESPOSTAZ4a.', 1800);
  const rig = await D.newRig(client, { humans: ['201', '205'] });
  const before = D.ttsCounters();
  await D.utter(rig, '205', 'Yui, qual a capital QWERTYZ4a?', { ms: 900 });
  await waitUntil(() => L.llmState.calls.length === 1, 8000);
  L.moveOutOfVoice(rig.members['205']);
  const out = await D.awaitOutcome(before);
  await D.settle(1500);
  check(D.chatFor(rig, '205')?.content.includes('RESPOSTAZ4a'), 'texto entregue no chat');
  check(out.requested && D.skippedCount('user-not-in-call') > (before.skipped['user-not-in-call'] || 0), 'fala recusada: user-not-in-call');
  check(D.audioSince(rig, 0).packets === 0, 'nenhum som');
  await cleanup(rig);
});

await run('S4b', 'Usuário sai do canal NO MEIO da fala (3 frases)', 'a frase em curso termina e as seguintes não tocam (canSpeak por frase)', async () => {
  const long = 'Primeira frase bem comprida para durar um tempo razoável aqui. Segunda frase também comprida para durar mais um pouco ainda. Terceira frase que não deveria ser dita em hipótese alguma.';
  D.setLlm(long);
  const rig = await D.newRig(client, { humans: ['201', '206'] });
  const before = D.ttsCounters();
  const t0 = Date.now();
  await D.utter(rig, '206', 'Yui, me conta algo QWERTYZ4b', { ms: 900 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(400);
  const leftAt = Date.now();
  L.moveOutOfVoice(rig.members['206']);
  await D.awaitOutcome(before);
  await sleep(500);
  const a = D.audioSince(rig, t0);
  const f = D.falas(rig).at(-1);
  check(f && /^[12]\/3$/.test(f.frases) && f.motivo === 'not-allowed', `parou entre frases: frases=${f?.frases} motivo=${f?.motivo}`);
  note(`depois que o usuário saiu a Yui ainda falou até ${a.lastWall ? a.lastWall - leftAt : '?'} ms (a frase em curso termina; as outras não tocam)`);
  await cleanup(rig);
});

await run('S5', 'Rádio já ativo na guild + pedido por voz', 'a Yui não responde nem fala (T1 1.1 item 6); o STT nem deveria ser gasto', async () => {
  D.setLlm('Não deveria falar.');
  const rig = await D.newRig(client, { humans: ['201', '207'] });
  L.radioDb.createSession(rig.id, rig.voiceChannel.id, rig.text.id); // sessão do rádio registrada (a conexão da call de IA continua a mesma)
  const sttBefore = L.stt.calls;
  const llmBefore = L.llmState.calls.length;
  await D.utter(rig, '207', 'Yui, qual a capital QWERTYZ5?', { ms: 900 });
  await D.settle(2500);
  check(L.llmState.calls.length === llmBefore && !D.chatFor(rig, '207'), 'sem IA e sem resposta');
  check(D.audioSince(rig, 0).packets === 0, 'sem fala');
  note(`STT em nuvem chamado ${L.stt.calls - sttBefore}x mesmo com o rádio ativo (a checagem de rádio vem DEPOIS do STT no voiceHandler; no fluxo real o rádio troca a conexão e o receiver da call de IA morre)`);
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S5b', 'Rádio INICIA durante a fala (startRadioMode real)', 'a fala para na hora (interruptSpeech radio), nada toca por cima da música, o TTS recusa as próximas', async () => {
  const long = 'Primeira frase bem comprida para durar um tempo razoável aqui. Segunda frase também comprida para durar mais um pouco ainda. Terceira frase final.';
  D.setLlm(long);
  const rig = await D.newRig(client, { humans: ['201', '208'] });
  const before = D.ttsCounters();
  const t0 = Date.now();
  await D.utter(rig, '208', 'Yui, me conta algo QWERTYZ5b', { ms: 900 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(300);
  const oldConn = rig.conn;
  const radioAt = Date.now();
  const startP = L.radioMgr.startRadioMode(rig.members['208'], rig.text, client);
  await waitUntil(() => L.voiceEsm.getVoiceConnection(rig.id) && L.voiceEsm.getVoiceConnection(rig.id) !== oldConn, 5000, 5);
  const newConn = L.voiceEsm.getVoiceConnection(rig.id);
  if (newConn && newConn !== oldConn) L.forceReady(newConn, `${rig.id}-radio`);
  const res = await startP.catch((e) => ({ success: false, error: String(e?.message) }));
  await sleep(800);
  const oldNet = oldConn.__net;
  const lastOld = oldNet.packets.filter((p) => !p.silent).at(-1)?.wall ?? 0;
  check(res?.success === true, `startRadioMode concluiu (${JSON.stringify(res)})`);
  check(L.radioDb.hasActiveSession(rig.id), 'sessão do rádio criada');
  check(lastOld - radioAt < 400, `a fala parou em ${lastOld - radioAt} ms depois do início do rádio`);
  const f = D.falas(rig).at(-1);
  check(f && f.motivo !== 'done', `a resposta terminou antes do fim: motivo=${f?.motivo} frases=${f?.frases}`);
  const voicedOnNew = newConn?.__net?.packets.filter((p) => !p.silent).length ?? 0;
  check(voicedOnNew === 0, 'nenhum pacote de voz da Yui na conexão nova do rádio');
  const late = L.tts.speakVoiceReply({ guildId: rig.id, userId: '208', text: 'Uma resposta que chega tarde.', transcript: 'qualquer coisa diferente', sensitive: false, requestedAt: Date.now(), fromVoice: true });
  check(late.ok === false && /radio|no-connection/.test(late.reason), `uma resposta tardia é recusada (${late.reason})`);
  const sub = newConn?.state?.subscription;
  check(!sub || sub.player !== undefined, 'a assinatura da conexão do rádio não foi tomada pelo player do TTS');
  try { newConn?.destroy(); } catch { /* ignora */ }
  await cleanup(rig);
});

await run('S6a', 'Pedido velho: IA lenta (> prazo)', 'texto entregue, mas NÃO falado (stale); com YUI_TTS_STALE_SECONDS=5', async () => {
  D.setLlm('Resposta tardia RESPOSTAZ6a.', 6500);
  const rig = await D.newRig(client, { humans: ['201', '209'] });
  const before = D.ttsCounters();
  await D.utter(rig, '209', 'Yui, qual a capital QWERTYZ6a?', { ms: 900 });
  const out = await D.awaitOutcome(before, 30000);
  await D.settle(1500);
  check(D.chatFor(rig, '209')?.content.includes('RESPOSTAZ6a'), 'o texto atrasado foi entregue');
  check(out.requested && D.skippedCount('stale') > (before.skipped.stale || 0), 'fala recusada: stale');
  check(D.audioSince(rig, 0).packets === 0, 'nenhum som');
  await cleanup(rig);
}, { tts: { cfg: { globalPerMin: 240, staleSeconds: 5 } } });

await run('S6b', 'Pedido velho na fila da IA', 'o 2º pedido (velho) é descartado antes da IA; a pessoa recebe um aviso curto (não fica no silêncio) e pode pedir de novo', async () => {
  process.env.YUI_TTS_STALE_SECONDS = '5';
  try {
    D.setLlm('Resposta do primeiro RESPOSTAZ6b.', 6500);
    const rig = await D.newRig(client, { humans: ['201', '210', '211'] });
    await D.utter(rig, '210', 'Yui, primeira pergunta QWERTYZ6b', { ms: 900 });
    await sleep(500);
    await D.utter(rig, '211', 'Yui, segunda pergunta QWERTYZ6c', { ms: 900 });
    await waitUntil(() => D.chatFor(rig, '210'), 20000);
    await D.settle(3500);
    const second = D.chatFor(rig, '211');
    check(L.llmState.calls.length === 1, `a IA foi chamada só 1x (${L.llmState.calls.length}): o pedido velho foi descartado sem gastar a IA`);
    check(second && /Demorei demais/.test(second.content) && !/RESPOSTAZ6/.test(second.content), 'o 2º usuário recebeu o aviso curto de que o pedido venceu (e não uma resposta)');
    // o aviso libera a vaga "pendente": passado o debounce de 6 s, a pergunta repetida é atendida
    L.stt.queue.length = 0;
    await sleep(1500);
    D.setLlm('Resposta nova RESPOSTAZ6c.');
    const llmBefore = L.llmState.calls.length;
    await D.utter(rig, '211', 'Yui, repito a pergunta QWERTYZ6d', { ms: 900 });
    await D.settle(3000);
    check(L.llmState.calls.length === llmBefore + 1 && D.allChatFor(rig, '211').some((m) => m.content.includes('RESPOSTAZ6c')), 'o 2º usuário repetiu a pergunta ~14 s depois e foi atendido');
    await cleanup(rig);
  } finally {
    delete process.env.YUI_TTS_STALE_SECONDS;
  }
}, { tts: { cfg: { globalPerMin: 240, staleSeconds: 5 } } });

// restaura o TTS padrão do harness
await D.startTts(client, { providers: [spy], cfg: { globalPerMin: 240 } });

// ════════════════════════════════════════════════════════════════════════════════════════════════
await run('S7', 'Resposta com dado pessoal (PII)', 'o texto vai ao chat; nada é falado (pii) — e-mail, telefone, CPF, IP, token, dígitos, numerais por extenso, e-mail falado', async () => {
  const humans = ['201', ...Array.from({ length: 8 }, (_, i) => String(301 + i))];
  const rig = await D.newRig(client, { humans });
  const cases = [
    ['email', 'Claro, o e-mail dela é maria.silva@gmail.com mesmo.'],
    ['telefone', 'O celular dela é (11) 98765-4321 pode ligar.'],
    ['cpf', 'O documento é 123.456.789-09 certinho.'],
    ['ip', 'O servidor fica em 192.168.0.10 e responde.'],
    ['token', 'A chave é sk-abcdefghijklmnopqrstuvwxyz0123456789 pronto.'],
    ['digitos', 'O protocolo é 9876543210123 anote aí.'],
    ['numerais', 'Anote: nove oito sete seis cinco quatro três dois um.'],
    ['email-falado', 'Manda para maria arroba gmail ponto com depois.'],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [label, text] = cases[i];
    const uid = String(301 + i);
    D.setLlm(text);
    const before = D.ttsCounters();
    await D.utter(rig, uid, `Yui, me diga o contato QWERTYZ7${label}`, { ms: 800 });
    await D.awaitOutcome(before);
    await sleep(300);
    const chat = D.chatFor(rig, uid)?.content ?? '';
    check(chat.length > 0 && D.skippedCount('pii') === (before.skipped.pii || 0) + 1, `${label}: texto no chat e fala recusada por pii`);
  }
  check(spy.spy.texts.length === 0 && D.audioSince(rig, 0).packets === 0, 'nada de nenhum deles chegou à síntese nem ao áudio');
  await cleanup(rig);
});

await run('S7b', 'Menção a pessoa cujo apelido é dado pessoal / palavra proibida', 'o nome é omitido da fala (T1b 12); a frase continua', async () => {
  const rig = await D.newRig(client, { humans: ['201', '320', '321', '322'] });
  rig.members['320'].displayName = 'maria.silva@gmail.com';
  rig.members['321'].displayName = 'Bruno Sombra';
  rig.members['322'].displayName = 'Yui Fã';
  D.setLlm('Oi <@320>, oi <@321>, oi <@322>, tudo bem por aí hoje?');
  const before = D.ttsCounters();
  await D.utter(rig, '201', 'Yui, cumprimente o pessoal QWERTYZ7b', { ms: 800 });
  await D.awaitOutcome(before);
  await D.settle(1500);
  const said = spy.spy.texts.join(' ');
  check(!/gmail|silva|arroba/i.test(said), `o apelido com e-mail não é falado ("${said.slice(0, 80)}")`);
  check(!/\bYui\b/i.test(said), 'o apelido que contém "Yui" (palavra de ativação) não é falado');
  check(/Bruno Sombra/.test(said), 'o apelido comum é falado');
  await cleanup(rig);
});

await run('S8', 'Resposta com JSON / chamada de ferramenta', 'a ferramenta NÃO executa; o chat mostra "Isso eu faço só pelo chat."; o JSON nunca é falado (T1b 2)', async () => {
  const humans = ['201', ...Array.from({ length: 5 }, (_, i) => String(330 + i))];
  const rig = await D.newRig(client, { humans });
  const cases = [
    ['json search_web', '{"thought":"buscar","tool":"search_web","args":{"query":"qualquer coisa"}}'],
    ['[Tool Use:]', '[Tool Use: download_audio args={"url":"https://youtu.be/dQw4w9WgXcQ"}]'],
    ['texto + json', 'Claro, já faço! {"thought":"x","tool":"download_video","args":{"url":"https://youtu.be/dQw4w9WgXcQ"}}'],
    ['default_api', 'print(default_api.search_web(query="foo"))'],
  ];
  const netBefore = L.net_calls.length;
  for (let i = 0; i < cases.length; i += 1) {
    const [label, raw] = cases[i];
    const uid = String(330 + i);
    D.setLlm(raw);
    const before = D.ttsCounters();
    const spyBefore = spy.spy.texts.length;
    await D.utter(rig, uid, `Yui, baixa isso pra mim QWERTYZ8${i}`, { ms: 800 });
    await D.awaitOutcome(before, 25000);
    await D.settle(1500);
    const chat = D.chatFor(rig, uid)?.content ?? '(sem resposta)';
    const spoken = spy.spy.texts.slice(spyBefore).join(' | ');
    check(!/[{}]|tool|default_api|youtu/i.test(chat), `${label}: nenhum JSON/URL no chat -> "${chat.replace(/^<@\d+> /, '').slice(0, 70)}"`);
    check(!/[{}]|tool|default_api|youtu/i.test(spoken), `${label}: nada de ferramenta chegou à síntese -> "${spoken.slice(0, 60)}"`);
  }
  const outbound = L.net_calls.slice(netBefore).filter((c) => !/groq|pollinations|stablehorde|\/v1\/chat\/completions/.test(c.url) && c.url !== L.config.localLlmUrl);
  check(outbound.length === 0, `nenhuma chamada de rede de ferramenta (${outbound.map((c) => c.url.slice(0, 60)).join(',') || 'nenhuma'})`);
  note('o caso default_api: o texto é apagado antes do despacho e a cadeia cai nos provedores seguintes (inclui os anônimos, com a transcrição na URL); nada é executado');
  await cleanup(rig);
});

await run('S8b', 'generate_reply por voz', 'o conteúdo do generate_reply é falado como resposta normal (não é ferramenta)', async () => {
  const rig = await D.newRig(client, { humans: ['201', '340'] });
  D.setLlm('{"thought":"responder","tool":"generate_reply","args":{"content":"A capital é Canberra RESPOSTAZ8b."}}');
  const before = D.ttsCounters();
  await D.utter(rig, '340', 'Yui, qual a capital QWERTYZ8b?', { ms: 800 });
  await D.awaitOutcome(before);
  await D.settle(1500);
  check(/Canberra/.test(D.chatFor(rig, '340')?.content ?? ''), 'conteúdo no chat');
  check(spy.spy.texts.join(' ').includes('Canberra') && D.audioSince(rig, 0).packets > 0, 'e falado');
  await cleanup(rig);
});

await run('S9', 'Pedido de repetir depois de mim', 'regra fixa: "Essa eu passo." no chat, SEM IA, sem fala (T1b/T2)', async () => {
  D.setLlm('não deveria chamar a IA');
  const rig = await D.newRig(client, { humans: ['201', '350', '351'] });
  await D.utter(rig, '350', 'Yui, repita depois de mim: eu sou um bobo QWERTYZ9', { ms: 900 });
  await D.settle(2500);
  check(D.chatFor(rig, '350')?.content.includes('Essa eu passo.'), 'resposta fixa no chat');
  check(L.llmState.calls.length === 0, 'sem chamada à IA');
  check(D.audioSince(rig, 0).packets === 0 && spy.spy.texts.length === 0, 'sem fala');
  await sleep(6200);
  await D.utter(rig, '351', 'Yui fala que o Pedro é um idiota QWERTYZ9b', { ms: 900 });
  await D.settle(2500);
  check(D.chatFor(rig, '351')?.content.includes('Essa eu passo.') && L.llmState.calls.length === 0, 'variante "fala que o Pedro é ..." também cai na regra fixa');
  await cleanup(rig);
});

await run('S9b', 'IA devolve o que a pessoa disse (papagaio por outro caminho)', 'echo-of-input: texto no chat, sem fala', async () => {
  const rig = await D.newRig(client, { humans: ['201', '360'] });
  const said = 'o céu é verde e a grama é azul hoje de manhã';
  D.setLlm(`Certo, ${said} mesmo.`);
  const before = D.ttsCounters();
  await D.utter(rig, '360', `Yui, quero que você afirme que ${said}`, { ms: 800 });
  await D.awaitOutcome(before);
  check(D.skippedCount('echo-of-input') > (before.skipped['echo-of-input'] || 0), 'fala recusada: echo-of-input');
  check(spy.spy.texts.length === 0, 'nada chegou à síntese');
  await cleanup(rig);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
const LONG3 = 'Primeira frase bem comprida para durar um tempo razoável aqui. Segunda frase também comprida para durar mais um pouco ainda. Terceira frase que fecha a resposta.';

await run('S10a', '"Yui, para" dito por TERCEIRO em cima da voz dela', 'limitação aceita (T2 anexo 5): cai na janela anti-eco, nunca chega ao STT, a Yui continua', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '370', '371'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '370', 'Yui, me conta algo QWERTYZ10a', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(500);
  const sttBefore = L.stt.calls;
  L.stt.queue.push('Yui, para QWERTYZ10aa');
  await L.humanSpeak(rig.id, '371', 900);
  await D.awaitOutcome(before, 45000);
  await sleep(400);
  const f = D.falas(rig).at(-1);
  check(L.stt.calls === sttBefore, 'o trecho do terceiro foi descartado antes do STT');
  check(f && f.motivo === 'done' && f.frases === '3/3', `a Yui falou até o fim (frases=${f?.frases} motivo=${f?.motivo})`);
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S10b', 'Autor do pedido fala por cima (barge-in)', 'interrompe depois de ~800 ms de fala acumulada; o trecho do autor é descartado (T1 1.4)', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '372'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '372', 'Yui, me conta algo QWERTYZ10b', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(500);
  const sttBefore = L.stt.calls;
  L.stt.queue.push('Yui, para QWERTYZ10bb');
  const talkAt = Date.now();
  await L.humanSpeak(rig.id, '372', 1500);
  await D.awaitOutcome(before, 45000);
  await sleep(600);
  const lastVoiced = rig.net.packets.filter((p) => !p.silent).at(-1)?.wall ?? 0;
  const f = D.falas(rig).at(-1);
  check(f && /barge-in/.test(f.motivo), `fala interrompida por barge-in (motivo=${f?.motivo})`);
  check(lastVoiced - talkAt < 1500, `silêncio ${lastVoiced - talkAt} ms depois que o autor começou a falar (limite 800 ms + latência)`);
  check(L.stt.calls === sttBefore, 'o trecho do autor (que causou o barge-in) foi descartado antes do STT');
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S10c', 'Terceiro fala por cima (não é o autor)', 'NÃO interrompe (barge-in é só do dono do pedido)', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '373', '374'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '373', 'Yui, me conta algo QWERTYZ10c', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(500);
  await L.humanSpeak(rig.id, '374', 2000);
  await D.awaitOutcome(before, 45000);
  await sleep(300);
  const f = D.falas(rig).at(-1);
  check(f && f.motivo === 'done' && f.frases === '3/3', `a Yui terminou (frases=${f?.frases} motivo=${f?.motivo})`);
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S10d', '"Yui, para" quando a fala ainda está sendo sintetizada (sem sobreposição)', 'o comando de parada cancela a fala pendente (interruptSpeech user-stop), sem IA', async () => {
  D.setLlm('Resposta que não deve ser falada RESPOSTAZ10d.');
  spy.spy.delayMs = 6000;
  const rig = await D.newRig(client, { humans: ['201', '375', '376'] });
  const before = D.ttsCounters();
  await D.utter(rig, '375', 'Yui, me conta algo QWERTYZ10d', { ms: 800 });
  await waitUntil(() => D.chatFor(rig, '375'), 15000);
  const llmBefore = L.llmState.calls.length;
  L.stt.queue.push('Yui, para');
  await L.humanSpeak(rig.id, '376', 700);
  await D.awaitOutcome(before, 30000);
  await sleep(500);
  const f = D.falas(rig).at(-1);
  check(f && /user-stop/.test(f.motivo), `a fala pendente foi cancelada por user-stop (motivo=${f?.motivo})`);
  check(L.llmState.calls.length === llmBefore, 'o comando não gastou IA');
  check(D.audioSince(rig, 0).packets === 0, 'nenhum som');
  await cleanup(rig);
});

await run('S10e', '"Yui, para" logo DEPOIS que a fala acabou', 'dentro dos 1500 ms de guarda é descartado antes do STT (inofensivo)', async () => {
  D.setLlm('Curta RESPOSTAZ10e.');
  const rig = await D.newRig(client, { humans: ['201', '377', '378'] });
  const before = D.ttsCounters();
  const t0 = Date.now();
  await D.utter(rig, '377', 'Yui, diga algo curto QWERTYZ10e', { ms: 800 });
  await D.awaitOutcome(before, 30000);
  await sleep(150);
  const sttBefore = L.stt.calls;
  L.stt.queue.push('Yui, para');
  await L.humanSpeak(rig.id, '378', 500);
  await D.settle(2000);
  check(L.stt.calls === sttBefore, `o trecho que começou dentro da guarda anti-eco não foi ao STT (${L.stt.calls - sttBefore})`);
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S11', 'Eco: o áudio da própria Yui volta pelo microfone de alguém', 'trecho sobreposto é descartado ANTES do STT; sem laço; depois da guarda o STT volta a funcionar', async () => {
  D.setLlm('Uma resposta de tamanho médio para o teste de eco ficar bem claro.');
  const rig = await D.newRig(client, { humans: ['201', '380', '381'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '380', 'Yui, fala algo QWERTYZ11', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  const sttBefore = L.stt.calls;
  L.stt.queue.push('Yui, qual a capital QWERTYZ11eco'); // se o eco passasse, viraria um pedido novo
  await L.humanSpeak(rig.id, '381', 1200, { offsetMs: 300 });
  await D.awaitOutcome(before, 30000);
  await D.settle(1500);
  check(L.stt.calls === sttBefore, `o eco não foi ao STT (${L.stt.calls - sttBefore} chamadas)`);
  check(L.llmState.calls.length === 1, 'nenhum pedido novo nasceu do eco');
  L.stt.queue.length = 0;
  // depois da guarda: volta a ouvir
  await sleep(2000);
  L.stt.queue.push('Yui, outra pergunta QWERTYZ11b');
  D.setLlm('Segunda resposta RESPOSTAZ11b.');
  await L.humanSpeak(rig.id, '381', 800);
  await D.settle(2500);
  check(L.stt.calls === sttBefore + 1 && D.chatFor(rig, '381')?.content.includes('RESPOSTAZ11b'), 'passada a guarda, o pedido seguinte é atendido');
  await cleanup(rig);
});

await run('S12a', 'Duas pessoas pedindo ao mesmo tempo (as duas capturas fecham antes da Yui começar)', 'as duas respostas saem no chat com a menção certa e são faladas em fila, sem se misturar', async () => {
  D.setLlm((b) => (/ALFA/.test(lastUser(b)) ? 'Resposta para a primeira pessoa, bem direta e curta.' : 'Resposta para a segunda pessoa, também direta e curta.'), 2500);
  const rig = await D.newRig(client, { humans: ['201', '390', '391'] });
  await L.humanPcm();
  const t0 = Date.now();
  L.stt.queue.push('Yui, pergunta ALFA QWERTYZ12a', 'Yui, pergunta BRAVO QWERTYZ12b');
  const a = L.humanSpeak(rig.id, '390', 900);
  await sleep(250);
  const b = L.humanSpeak(rig.id, '391', 900);
  await Promise.all([a, b]);
  await waitUntil(() => D.falas(rig).length >= 2, 40000);
  await D.settle(1500);
  const ca = D.chatFor(rig, '390');
  const cb = D.chatFor(rig, '391');
  check(ca?.content.includes('primeira pessoa') && cb?.content.includes('segunda pessoa'), 'cada pessoa recebeu a própria resposta no chat');
  check(spy.spy.texts.length === 2 && /primeira/.test(spy.spy.texts[0]) && /segunda/.test(spy.spy.texts[1]), `falou as duas, em ordem: ${JSON.stringify(spy.spy.texts.map((t) => t.slice(0, 20)))}`);
  const voiced = rig.net.packets.filter((p) => !p.silent && p.wall >= t0);
  let gap = 0;
  for (let i = 1; i < voiced.length; i += 1) gap = Math.max(gap, voiced[i].wall - voiced[i - 1].wall);
  check(voiced.length > 100, `${voiced.length} pacotes de voz em um único fluxo (um player só)`);
  note(`maior intervalo entre pacotes de voz consecutivos: ${gap} ms (a pausa entre as duas falas)`);
  await cleanup(rig);
});

await run('S12b', 'Segunda pessoa termina de falar ANTES da Yui começar, mas a captura dela fecha DEPOIS', 'o pedido da segunda pessoa é atendido (não houve sobreposição de verdade)', async () => {
  D.setLlm((b) => (/ALFA/.test(lastUser(b)) ? 'Resposta para a primeira pessoa, bem direta e curta.' : 'Resposta para a segunda pessoa, também direta e curta.'), 1300);
  const rig = await D.newRig(client, { humans: ['201', '392', '393'] });
  await L.humanPcm();
  const t0 = Date.now();
  const endedAt = {};
  rig.conn.receiver.speaking.on('end', (u) => { endedAt[u] = Date.now(); });
  const sttBefore = L.stt.calls;
  L.stt.queue.push('Yui, pergunta ALFA QWERTYZ12c', 'Yui, pergunta BRAVO QWERTYZ12d');
  const a = L.humanSpeak(rig.id, '392', 900);
  await sleep(1600);
  const b = L.humanSpeak(rig.id, '393', 900);
  await Promise.all([a, b]);
  await sleep(9000);
  const first = rig.net.packets.find((p) => !p.silent)?.wall ?? 0;
  note(`B parou de falar ${first - endedAt['393']} ms ANTES de a Yui começar; STT chamado ${L.stt.calls - sttBefore}x; resposta de B: ${D.chatFor(rig, '393') ? 'sim' : 'NÃO (descartado sem aviso)'}`);
  check(first > endedAt['393'], 'pré-condição: a fala de B terminou antes do primeiro som da Yui');
  check(L.stt.calls - sttBefore === 2 && D.chatFor(rig, '393'), 'o pedido de B foi atendido');
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S13a', 'Yui sai da call NO MEIO da fala', 'a fala para na hora (disposeGuild), nada fica pendente, histórico de voz é limpo', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '395'] });
  const t0 = Date.now();
  await D.utter(rig, '395', 'Yui, me conta algo QWERTYZ13a', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(500);
  const leaveAt = Date.now();
  await L.voice.leaveVoiceCall(rig.id, rig.text);
  await sleep(600);
  const last = rig.net.packets.filter((p) => !p.silent).at(-1)?.wall ?? 0;
  check(last - leaveAt < 300, `a fala parou ${last - leaveAt} ms depois de sair`);
  check(!L.tts.isSpeaking(rig.id), 'isSpeaking(guild) é falso');
  check(rig.conn.state.status === 'destroyed', 'a conexão foi destruída');
  check(rig.text.texts().some((t) => /Saí do canal/.test(t)), 'avisou no chat que saiu');
  check(L.llm.clearVoiceHistory(rig.id) === 0, 'o histórico de voz já tinha sido limpo na saída');
  await cleanup(rig);
});

await run('S13b', 'Yui sai da call enquanto a IA ainda processa', 'a resposta chega ao chat; sem fala (no-connection); sem erro solto', async () => {
  D.setLlm('Resposta tardia RESPOSTAZ13b.', 2500);
  const rig = await D.newRig(client, { humans: ['201', '396'] });
  const before = D.ttsCounters();
  await D.utter(rig, '396', 'Yui, qual a capital QWERTYZ13b?', { ms: 800 });
  await waitUntil(() => L.llmState.calls.length === 1, 10000);
  await L.voice.leaveVoiceCall(rig.id, rig.text);
  const out = await D.awaitOutcome(before, 25000);
  await D.settle(1500);
  check(D.chatFor(rig, '396')?.content.includes('RESPOSTAZ13b'), 'texto entregue');
  check(out.requested && D.skippedCount('no-connection') > (before.skipped['no-connection'] || 0), 'fala recusada: no-connection');
  check(D.audioSince(rig, 0).packets === 0, 'nenhum som');
  await cleanup(rig);
});

await run('S13c', 'Comando de voz "Yui, sai da call"', 'comando fixo (sem IA): sai, destrói a conexão, limpa a fala', async () => {
  D.setLlm('não deveria chamar a IA');
  const rig = await D.newRig(client, { humans: ['201', '397'] });
  const llmBefore = L.llmState.calls.length;
  await D.utter(rig, '397', 'Yui, sai da call QWERTYZ13c', { ms: 800 });
  await D.settle(2500);
  check(rig.conn.state.status === 'destroyed', 'saiu da call');
  check(L.llmState.calls.length === llmBefore, 'sem IA');
  check(rig.text.texts().some((t) => /Saí do canal/.test(t)), 'avisou no chat');
  await cleanup(rig);
});

await run('S13d', 'Todos saem da call enquanto a Yui fala (handleVoiceStateUpdate)', 'a Yui sai por inatividade e a fala para junto', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '399'] });
  const t0 = Date.now();
  await D.utter(rig, '399', 'Yui, me conta algo QWERTYZ13d', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(400);
  const at = Date.now();
  L.moveOutOfVoice(rig.members['201']);
  L.moveOutOfVoice(rig.members['399']);
  await L.voice.handleVoiceStateUpdate({ guild: rig.guild, client }, { guild: rig.guild });
  await sleep(600);
  const last = rig.net.packets.filter((p) => !p.silent).at(-1)?.wall ?? 0;
  check(rig.text.texts().some((t) => /Todos sa[íi]ram da call/.test(t)), 'avisou que saiu por inatividade');
  check(last - at < 300, `a fala parou ${last - at} ms depois`);
  check(rig.conn.state.status === 'destroyed' && !L.tts.isSpeaking(rig.id), 'conexão destruída e sem fala em curso');
  await cleanup(rig);
});

await run('S13e', 'Queda real da conexão ENQUANTO a Yui fala', 'a fala termina (connection-lost) e o voiceHandler limpa tudo, sem exceção', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '399'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '399', 'Yui, me conta algo QWERTYZ13e', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(400);
  const conn = rig.conn;
  const dropAt = Date.now();
  conn.state = { status: 'disconnected', reason: 0, closeCode: 4014, adapter: conn.state.adapter, subscription: conn.state.subscription };
  await sleep(6500);
  const f = D.falas(rig).at(-1);
  check(f && /disposed|connection-lost/.test(f.motivo), `a fala terminou na queda (motivo=${f?.motivo} frases=${f?.frases})`);
  check(rig.text.texts().some((t) => /Fui removida/.test(t)), 'avisou "Fui removida do canal de voz"');
  check(!L.tts.isSpeaking(rig.id) && L.voice.getActiveVoiceConnection(rig.id) === undefined, 'sem fala em curso e fora do registro');
  try { conn.destroy(); } catch { /* ignora */ }
  await cleanup(rig);
});

await run('S14', 'Desligar o interruptor NO MEIO da fala (pelo painel)', 'a fala em curso é CORTADA na hora (interruptSpeech "switch-off") e as frases seguintes não tocam', async () => {
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '398'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '398', 'Yui, me conta algo QWERTYZ14', { ms: 800 });
  await waitUntil(() => rig.net.packets.some((p) => !p.silent && p.wall >= t0), 20000);
  await sleep(500);
  const offAt = Date.now();
  const clicks = [];
  const click = { customId: `srvmcp_toggle_${rig.id}_voice_tts_off`, guildId: rig.id, guild: { id: rig.id }, user: { id: '999' }, member: { permissions: { has: () => true } }, update: async (p) => { clicks.push(p); }, reply: async (p) => { clicks.push(p); } };
  await L.panel.handleMcpToolInteraction(click);
  await D.awaitOutcome(before, 40000);
  await sleep(600);
  const last = rig.net.packets.filter((p) => !p.silent).at(-1)?.wall ?? 0;
  const f = D.falas(rig).at(-1);
  check(L.llm.isToolDisabled(rig.id, 'voice_tts') === true && clicks.length === 1, 'o painel desligou o interruptor');
  check(f && f.motivo === 'switch-off' && /^[012]\/3$/.test(f.frases), `a fala foi interrompida pelo interruptor (frases=${f?.frases} motivo=${f?.motivo})`);
  check(last - offAt < 400, `silêncio ${last - offAt} ms depois de desligar (antes a frase em curso terminava)`);
  await cleanup(rig);
});

await run('S15a', 'Falha do SAPI: voz inexistente (SAPI_NOVOICE, real)', 'só texto; sem exceção solta; o disjuntor abre depois de 3 falhas', async () => {
  const broken = await D.makeRealSapi({ sapiVoice: 'VozQueNaoExiste' });
  const spyBroken = D.makeSpyProvider(broken);
  await D.startTts(client, { providers: [spyBroken], cfg: { globalPerMin: 240, userGapSeconds: 0 } });
  const rig = await D.newRig(client, { humans: ['201', '400', '401', '402', '403'], warm: false });
  D.setLlm('Resposta normal RESPOSTAZ15.');
  const results15 = [];
  for (const uid of ['400', '401', '402', '403']) {
    const before = D.ttsCounters();
    await D.utter(rig, uid, `Yui, qual a capital QWERTYZ15${uid}?`, { ms: 800 });
    await D.awaitOutcome(before, 30000);
    await sleep(200);
    results15.push({ uid, text: Boolean(D.chatFor(rig, uid)), audio: D.audioSince(rig, 0).packets });
  }
  check(results15.every((x) => x.text), 'as 4 respostas chegaram ao chat');
  check(results15.every((x) => x.audio === 0), 'nenhum som');
  const c = D.ttsCounters();
  note(`contadores: finished=${JSON.stringify(c.finished)} skipped=${JSON.stringify(c.skipped)}`);
  check(L.escaped.length === 0, `nenhuma exceção/rejeição solta (${L.escaped.join(' ; ') || 'ok'})`);
  await cleanup(rig);
  await broken.dispose();
});

await run('S15b', 'Falha do provedor no meio (2ª frase)', 'a 1ª frase toca e a resposta termina limpa', async () => {
  await D.startTts(client, { providers: [spy], cfg: { globalPerMin: 240, userGapSeconds: 0 } });
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '404'] });
  const orig = spy.synth;
  let n = 0;
  spy.synth = async (text, opts) => { n += 1; if (n === 2) { const e = new Error('x'); e.code = 'SAPI_EXIT'; throw e; } return orig(text, opts); };
  const before = D.ttsCounters();
  await D.utter(rig, '404', 'Yui, me conta algo QWERTYZ15b', { ms: 800 });
  await D.awaitOutcome(before, 40000);
  await sleep(500);
  spy.synth = orig;
  const f = D.falas(rig).at(-1);
  check(f && /^1\/3$/.test(f.frases), `tocou só a 1ª frase (frases=${f?.frases} motivo=${f?.motivo})`);
  check(D.chatFor(rig, '404'), 'texto completo no chat');
  await cleanup(rig);
});

await run('S15c', 'O helper do SAPI é morto (antivírus/usuário) entre duas falas', 'a fala seguinte reinicia o helper sozinha e a Yui continua falando', async () => {
  await D.startTts(client, { providers: [spy], cfg: { globalPerMin: 240, userGapSeconds: 0 } });
  D.setLlm('Resposta depois do helper morrer RESPOSTAZ15c.');
  const rig = await D.newRig(client, { humans: ['201', '406', '407'] });
  const ask = async (uid, label) => {
    const before = D.ttsCounters();
    await D.utter(rig, uid, `Yui, qual a capital QWERTYZ15c${label}?`, { ms: 800 });
    await D.awaitOutcome(before, 40000);
    await D.settle(1500);
    return D.falas(rig).at(-1);
  };
  const f1 = await ask('406', 'a');
  const pid = realSapi.getInfo().pid;
  check(f1?.motivo === 'done' && pid, `1ª fala normal (helper pid ${pid ? 'ok' : 'ausente'})`);
  try { process.kill(pid); } catch (e) { note('não consegui matar o helper: ' + e.code); }
  await sleep(500);
  const f2 = await ask('407', 'b');
  check(f2?.motivo === 'done', `depois de matar o helper a fala seguinte funcionou (motivo=${f2?.motivo}, ms_pedido_ate_pronto=${f2?.ms_pedido_ate_pronto})`);
  check(realSapi.getInfo().pid && realSapi.getInfo().pid !== pid, 'um helper novo está rodando');
  check(L.escaped.length === 0, 'sem exceção solta');
  await cleanup(rig);
});

await run('S16', 'Opus indisponível no boot do TTS', 'TTS desligado (no-opus); o bot segue respondendo em texto, sem erro', async () => {
  const r = await D.startTts(client, { providers: [spy], opus: false });
  check(r.enabled === false && r.reason === 'no-opus', `initTts: ${JSON.stringify({ enabled: r.enabled, reason: r.reason })}`);
  D.setLlm('Resposta só em texto RESPOSTAZ16.');
  const rig = await D.newRig(client, { humans: ['201', '405'], warm: false });
  await D.utter(rig, '405', 'Yui, qual a capital QWERTYZ16?', { ms: 800 });
  await D.settle(2500);
  check(D.chatFor(rig, '405')?.content.includes('RESPOSTAZ16'), 'a resposta de texto saiu normalmente');
  check(D.audioSince(rig, 0).packets === 0, 'sem fala');
  check(L.tts.speakVoiceReply({ guildId: rig.id }).reason === 'tts-off' && (await L.tts.warmupTts()) === false, 'speakVoiceReply = tts-off; warmupTts = false (nada lança)');
  check(/desligada.*Opus/.test(L.statusCmd.formatTtsStatusLine(L.tts.getTtsStatus())), `linha do /status (motivo em português): ${L.statusCmd.formatTtsStatusLine(L.tts.getTtsStatus())}`);
  // docs/OPERACAO.md: "desligue com YUI_TTS_ENABLED=false e reinicie: tudo volta a ser só texto". A voz também: sem persona de voz e com as ferramentas de antes.
  const body16 = L.llmState.calls.at(-1);
  check(!sysOf(body16).endsWith(VOICE_TEXT) && hasToolsText(sysOf(body16)), 'com o TTS desligado (init) a conversa por voz é a de antes: sem persona de voz e com a oferta de ferramentas');
  await cleanup(rig);
  await D.startTts(client, { providers: [spy], cfg: { globalPerMin: 240 } });
});

await run('S17', 'Palavra de ativação no MEIO da frase', 'responde só em texto (T1b 19), mas continua sendo pedido de VOZ: sem persona curta, sem ferramentas (nem execução) e sem fala', async () => {
  D.setLlm('Resposta normal RESPOSTAZ17.');
  const rig = await D.newRig(client, { humans: ['201', '406'] });
  const before = D.ttsCounters();
  await D.utter(rig, '406', 'Eu queria saber por favor se a Yui conhece a capital QWERTYZ17', { ms: 900 });
  await D.settle(3000);
  const body = L.llmState.calls.at(-1);
  check(D.chatFor(rig, '406')?.content.includes('RESPOSTAZ17'), 'respondeu em texto');
  check(D.ttsCounters().requests === before.requests && D.audioSince(rig, 0).packets === 0, 'o TTS nem foi chamado; sem fala');
  check(!sysOf(body).endsWith(VOICE_TEXT), 'sem a persona curta de voz (a resposta fica só no texto)');
  check(!hasToolsText(sysOf(body)), 'e SEM a oferta de ferramentas (antes este caminho burlava o YUI_VOICE_TOOLS=false)');
  // uma ferramenta devolvida pela IA tampouco executa (o menu é local e inofensivo: se executasse, apareceria um embed)
  await sleep(6300); // passa o debounce de 6 s
  D.setLlm('{"thought":"menu","tool":"show_bot_menu","args":{"context":"geral"}}');
  await D.utter(rig, '406', 'Eu queria que a Yui abrisse o menu de ajuda QWERTYZ17b', { ms: 900 });
  await D.settle(2500);
  const answer = D.allChatFor(rig, '406').at(-1)?.content ?? '';
  check(/s[óo] pelo chat/.test(answer), `a IA pediu uma ferramenta e a resposta foi a recusa fixa ("${answer.replace(/^<@\d+> /, '').slice(0, 50)}")`);
  check(!rig.text.sent.some((m) => Array.isArray(m.payload?.embeds) && m.payload.embeds.length > 0), 'nenhum embed de ferramenta foi enviado');
  await cleanup(rig);
});

await run('S18', 'Resposta que cita o próprio nome', 'self-trigger: não fala (evita acionar o microfone de novo); é o preço da regra anti-laço', async () => {
  D.setLlm('Eu sou a Yui, uma assistente simpática.');
  const rig = await D.newRig(client, { humans: ['201', '407'] });
  const before = D.ttsCounters();
  await D.utter(rig, '407', 'Yui, quem é você QWERTYZ18?', { ms: 800 });
  await D.awaitOutcome(before);
  check(D.skippedCount('self-trigger') > (before.skipped['self-trigger'] || 0), 'fala recusada: self-trigger');
  note('a persona manda "não diga o seu próprio nome", mas a pergunta mais natural ("quem é você?") provoca justamente isso');
  await cleanup(rig);
});

await run('S19', 'Resposta longa, com código e links', 'chat <= 1900 caracteres; fala curta (<= 3 frases) ou apontamento para o chat', async () => {
  const code = '```js\nconsole.log("oi");\n```';
  const long = `Aqui vai uma explicação grande. ${'Esta é uma frase de enchimento para ficar grande. '.repeat(70)}\n${code}\nVeja https://exemplo.com/artigo para mais detalhes.`;
  D.setLlm(long);
  const rig = await D.newRig(client, { humans: ['201', '408'] });
  const before = D.ttsCounters();
  await D.utter(rig, '408', 'Yui, explica tudo em detalhes QWERTYZ19', { ms: 800 });
  await D.awaitOutcome(before, 45000);
  await D.settle(1500);
  const chat = D.chatFor(rig, '408')?.content ?? '';
  check(chat.replace(/^<@\d+> /, '').length <= 1900, `chat com ${chat.length} caracteres`);
  const said = spy.spy.texts.join(' ');
  check(said.length > 0 && said.length <= 260 && !/https?:|```|console/.test(said), `fala curta e limpa (${said.length} caracteres): "${said.slice(0, 90)}..."`);
  note(`frases enviadas à síntese: ${JSON.stringify(spy.spy.texts.map((t) => t.slice(-40)))}`);
  const a = D.audioSince(rig, 0);
  check(a.speechMs > 0 && a.speechMs <= 27000, `duração falada ${a.speechMs} ms (limite 25 s)`);
  await cleanup(rig);
});

await run('S20', 'Rodapé do modelo (-# ...) com "mostrar modelo" ligado', 'o rodapé não é falado', async () => {
  L.llm.updateShowModel(true);
  try {
    D.setLlm('Canberra é a capital RESPOSTAZ20.');
    const rig = await D.newRig(client, { humans: ['201', '409'] });
    const before = D.ttsCounters();
    await D.utter(rig, '409', 'Yui, qual a capital QWERTYZ20?', { ms: 800 });
    await D.awaitOutcome(before);
    await D.settle(1500);
    const chat = D.chatFor(rig, '409')?.content ?? '';
    const said = spy.spy.texts.join(' ');
    note(`rodapé no chat: ${/-# /.test(chat) ? 'sim' : 'não'}; texto da síntese: "${said}"`);
    check(said.length > 0 && !/modelo|gemini|local|-#|\|/i.test(said), 'o rodapé não chegou à síntese');
    await cleanup(rig);
  } finally {
    L.llm.updateShowModel(false);
  }
});

await run('S21', 'Bot e membro desconhecido falando na call', 'ignorados antes do STT (T1b 19)', async () => {
  D.setLlm('não deveria responder');
  const rig = await D.newRig(client, { humans: ['201', '410'], bots: ['900'] });
  rig.members['410'].voice.selfMute = true;
  const sttBefore = L.stt.calls;
  L.stt.queue.push('Yui, toca uma música');
  await L.humanSpeak(rig.id, '900', 800); // o bot de música
  await sleep(1800);
  check(L.stt.calls === sttBefore, 'áudio de bot não vai ao STT');
  L.stt.queue.push('Yui, quem sou eu');
  await L.humanSpeak(rig.id, '777', 800); // alguém que a Discord não confirma (fora do cache)
  await sleep(1800);
  check(L.stt.calls === sttBefore, 'membro desconhecido não vai ao STT (falha fechada)');
  L.stt.queue.push('Yui, estou mutado');
  await L.humanSpeak(rig.id, '410', 800); // humano com selfMute
  await sleep(1800);
  check(L.stt.calls === sttBefore, 'membro com selfMute não vai ao STT');
  L.stt.queue.length = 0;
  await cleanup(rig);
});

await run('S22', 'joinVoiceCall repetido (ouvintes não empilham)', 'um único STT e uma única resposta por fala', async () => {
  D.setLlm('Resposta única RESPOSTAZ22.');
  const rig = await D.newRig(client, { humans: ['201', '411'] });
  const again = await L.joinCall(rig, rig.author);
  const again2 = await L.joinCall(rig, rig.author);
  check(again.ok === true && again2.ok === true && rig.text.texts().filter((t) => /Já estou conectada/.test(t)).length >= 1, 'entrada repetida reaproveita a conexão');
  const sttBefore = L.stt.calls;
  await D.utter(rig, '411', 'Yui, qual a capital QWERTYZ22?', { ms: 800 });
  await D.settle(3000);
  check(L.stt.calls === sttBefore + 1, `1 chamada ao STT (${L.stt.calls - sttBefore})`);
  check(L.llmState.calls.length === 1 && D.allChatFor(rig, '411').length === 1, `1 chamada à IA e 1 resposta no chat (${L.llmState.calls.length}/${D.allChatFor(rig, '411').length})`);
  await cleanup(rig);
});

await run('S23', 'Debounce e pedido pendente por usuário', 'o 2º pedido em < 6 s é descartado; com a 1ª ainda pendente, descartado também; sem aviso ao usuário', async () => {
  D.setLlm('Resposta lenta RESPOSTAZ23.', 3000);
  const rig = await D.newRig(client, { humans: ['201', '412'] });
  await D.utter(rig, '412', 'Yui, primeira QWERTYZ23a', { ms: 800 });
  await sleep(300);
  await D.utter(rig, '412', 'Yui, segunda QWERTYZ23b', { ms: 800 });
  await D.settle(3500);
  check(L.llmState.calls.length === 1, `só 1 chamada à IA (${L.llmState.calls.length})`);
  check(D.allChatFor(rig, '412').length === 1, 'só 1 resposta no chat');
  note('o usuário que repete rápido não recebe nenhum aviso (só o log)');
  await cleanup(rig);
});

await run('S24', 'Duas guilds ao mesmo tempo', 'cada guild ouve só a própria resposta; sem mistura entre servidores', async () => {
  D.setLlm((b) => (/GUILDA1/.test(lastUser(b)) ? 'Resposta da primeira guilda, bem curta mesmo.' : 'Resposta da segunda guilda, bem curta mesmo.'));
  const r1 = await D.newRig(client, { humans: ['201', '413'] });
  const r2 = await D.newRig(client, { humans: ['201', '414'] });
  const t0 = Date.now();
  L.stt.queue.push('Yui, pergunta GUILDA1 QWERTYZ24a', 'Yui, pergunta GUILDA2 QWERTYZ24b');
  const a = L.humanSpeak(r1.id, '413', 800);
  await sleep(250);
  const b = L.humanSpeak(r2.id, '414', 800);
  await Promise.all([a, b]);
  await waitUntil(() => D.falas(r1).length >= 1 && D.falas(r2).length >= 1, 40000);
  await D.settle(1500);
  const a1 = D.audioSince(r1, t0);
  const a2 = D.audioSince(r2, t0);
  check(a1.packets > 0 && a2.packets > 0, `as duas guilds ouviram a Yui (${a1.packets}/${a2.packets} pacotes)`);
  check(/primeira guilda/.test(D.chatFor(r1, '413')?.content ?? '') && /segunda guilda/.test(D.chatFor(r2, '414')?.content ?? ''), 'cada chat recebeu a própria resposta');
  check(spy.spy.texts.length === 2, `2 sínteses no total (${spy.spy.texts.length})`);
  await cleanup(r1);
  await cleanup(r2);
});

await run('S25', 'Reconexão: Disconnected -> Signalling em 1 s', 'nada é descartado; a Yui continua a falar depois', async () => {
  D.setLlm('Resposta depois da reconexão RESPOSTAZ25.');
  const rig = await D.newRig(client, { humans: ['201', '415'] });
  const conn = rig.conn;
  const net = conn.__net;
  const sub = conn.state.subscription;
  conn.state = { status: 'disconnected', reason: 0, closeCode: 4014, adapter: conn.state.adapter, subscription: sub };
  await sleep(700);
  conn.state = { status: 'signalling', adapter: conn.state.adapter, subscription: sub };
  await sleep(300);
  conn.state = { status: 'ready', adapter: conn.state.adapter, networking: net, subscription: sub };
  await sleep(500);
  check(L.voice.getActiveVoiceConnection(rig.id)?.connection === conn, 'a call continua registrada no voiceHandler');
  check(!rig.text.texts().some((t) => /Fui removida/.test(t)), 'não avisou "Fui removida do canal"');
  const before = D.ttsCounters();
  await D.utter(rig, '415', 'Yui, qual a capital QWERTYZ25?', { ms: 800 });
  await D.awaitOutcome(before);
  await D.settle(1500);
  check(D.audioSince(rig, 0).packets > 0, 'e depois da reconexão a Yui fala');
  await cleanup(rig);
});

await run('S26', 'Queda real: Disconnected sem voltar em 5 s', 'avisa "Fui removida", limpa a fala e o histórico de voz, sem exceção', async () => {
  D.setLlm('Resposta RESPOSTAZ26.');
  const rig = await D.newRig(client, { humans: ['201', '416'] });
  const conn = rig.conn;
  conn.state = { status: 'disconnected', reason: 0, closeCode: 4014, adapter: conn.state.adapter, subscription: conn.state.subscription };
  await sleep(6500);
  check(rig.text.texts().some((t) => /Fui removida/.test(t)), 'avisou "Fui removida do canal de voz"');
  check(L.voice.getActiveVoiceConnection(rig.id) === undefined, 'saiu do registro do voiceHandler');
  check(L.escaped.length === 0, `sem exceção solta (${L.escaped.join(' ; ') || 'ok'})`);
  try { conn.destroy(); } catch { /* ignora */ }
  await cleanup(rig);
});

await run('S27', 'DAVE: código de privacidade demora a aparecer', 'espera até 3 s antes da 1ª fala da conexão; depois não espera mais (T1b 7)', async () => {
  D.setLlm('Primeira resposta com DAVE RESPOSTAZ27.');
  const rig = await D.newRig(client, { humans: ['201', '417'] });
  const net = rig.conn.__net;
  net.state.dave = { protocolVersion: 1, voicePrivacyCode: undefined };
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '417', 'Yui, qual a capital QWERTYZ27?', { ms: 800 });
  await waitUntil(() => D.chatFor(rig, '417'), 15000);
  const chatAt = Date.now();
  setTimeout(() => { net.state.dave.voicePrivacyCode = '12345'; }, 1500);
  await D.awaitOutcome(before, 30000);
  await D.settle(1500);
  const a = D.audioSince(rig, t0);
  const waited = a.firstWall ? a.firstWall - chatAt : -1;
  check(a.packets > 0, 'falou depois que o código apareceu');
  check(waited >= 1200, `o primeiro som esperou o código (${waited} ms depois do texto)`);
  await cleanup(rig);
});

await run('S28', 'Dono (escopo pessoal) pede por voz', 'escopo PÚBLICO na voz: fala permitida; sem persona/memória pessoal (T1b 11)', async () => {
  D.setLlm('Resposta ao dono RESPOSTAZ28.');
  const rig = await D.newRig(client, { humans: ['201', '111'] });
  const before = D.ttsCounters();
  await D.utter(rig, '111', 'Yui, qual a capital QWERTYZ28?', { ms: 800 });
  await D.awaitOutcome(before);
  await D.settle(1500);
  const body = L.llmState.calls.at(-1);
  check(!sysOf(body).includes('conversa com seu dono'), 'a persona pessoal do dono não vazou para a voz');
  check(D.audioSince(rig, 0).packets > 0, 'o dono foi atendido por voz (sensitive=false)');
  await cleanup(rig);
});

await run('S29', 'Laço de eventos durante a fala', 'a codificação Opus e a síntese não travam o bot (p99 < 50 ms, T1b 3)', async () => {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  D.setLlm(LONG3);
  const rig = await D.newRig(client, { humans: ['201', '420'] });
  const t0 = Date.now();
  const before = D.ttsCounters();
  await D.utter(rig, '420', 'Yui, me conta algo QWERTYZ29', { ms: 800 });
  await waitUntil(() => D.chatFor(rig, '420'), 20000); // a partir do texto entregue: só o trabalho do TTS (síntese + codificação + player)
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  await D.awaitOutcome(before, 45000);
  await sleep(300);
  h.disable();
  const ms = (ns) => Math.round(ns / 1e6);
  const a = D.audioSince(rig, t0);
  note(`atraso do laço de eventos durante ${a.spanMs} ms de fala: p50=${ms(h.percentile(50))} ms, p99=${ms(h.percentile(99))} ms, máx=${ms(h.max)} ms`);
  check(ms(h.percentile(99)) < 50, `p99 abaixo de 50 ms (${ms(h.percentile(99))} ms)`);
  check(ms(h.max) < 250, `pico abaixo de 250 ms (${ms(h.max)} ms)`);
  await cleanup(rig);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Auditoria final de privacidade e de efeitos colaterais
// ════════════════════════════════════════════════════════════════════════════════════════════════
if (only.length === 0) {
  const r = scenario('Z', 'Auditoria final', 'nenhum conteúdo de fala nos logs; nada escrito dentro do projeto; nenhuma exceção solta');
  await sleep(1500);
  const logsDir = `${L.tmp}/logs`;
  let fileText = '';
  try {
    const fs = await import('node:fs');
    for (const f of fs.readdirSync(logsDir)) if (/\.log$/.test(f)) fileText += fs.readFileSync(`${logsDir}/${f}`, 'utf8');
  } catch { /* sem arquivos */ }
  const haystacks = { 'arquivos de log': fileText, 'stdout capturado': L.captured.stdout.join(''), 'console capturado': L.captured.console.join('\n'), 'logs do TTS': L.ttsLogs.map((x) => x[1]).join('\n') };
  for (const [name, text] of Object.entries(haystacks)) {
    const hits = [...new Set(text.match(/QWERTYZ\w*|RESPOSTAZ\w*/g) || [])];
    check(hits.length === 0, `${name}: nenhum trecho de transcrição/resposta${hits.length ? ` (VAZOU: ${hits.slice(0, 5).join(', ')})` : ''}`);
  }
  check(L.escaped.length === 0, `nenhuma exceção/rejeição solta (${L.escaped.join(' ; ') || 'ok'})`);
  check(!L.swallowedWrites.some((w) => /historico/.test(w)), 'nada gravado no historico.txt');
  note(`escritas dentro do projeto engolidas pelo harness: ${[...new Set(L.swallowedWrites)].join(', ') || 'nenhuma'}`);
  // só o host: a URL dos provedores anônimos carrega o texto do pedido (nunca imprimir isso)
  const hostOf = (u) => { try { return new URL(u).host; } catch { return 'url-invalida'; } };
  note(`chamadas de rede interceptadas (fora STT/IA; só o host): ${[...new Set(L.net_calls.filter((c) => !/groq|chat\/completions/.test(c.url)).map((c) => hostOf(c.url)))].join(', ') || 'nenhuma'}`);
  say('\n[Z] Auditoria final');
  for (const c of r.checks) say(`      ${c.ok ? 'ok  ' : 'XX  '}${c.text}`);
  for (const n of r.notes) say(`      obs ${n}`);
}

// ── resumo ──────────────────────────────────────────────────────────────────────────────────────
say('\n══════════ RESUMO ══════════');
for (const r of D.results) say(`${D.status(r).padEnd(18)} ${r.id.padEnd(5)} ${r.title}`);
const bad = D.results.filter((r) => D.status(r) !== 'CONFERE');
say(`\n${D.results.length - bad.length}/${D.results.length} cenários conferem`);
await realSapi.dispose();
await L.tts.shutdownTts();
process.exit(bad.length ? 1 : 0);

