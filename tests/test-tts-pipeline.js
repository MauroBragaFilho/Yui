// Teste de PONTA A PONTA do TTS (src/services/tts/index.js), sem Discord, sem rede e sem voz real.
//
// Provedor FALSO (senoide) + gerenciador de saída REAL com player/conexão/recurso FALSOS e
// relógio falso: nenhuma espera de verdade. Cobre o caminho completo
//   texto da IA -> portões -> normalização -> frases -> síntese -> PCM Discord -> player
// e as garantias de segurança: não lança, não deixa rejeição solta, não vaza o texto falado
// para nenhum log e não deixa timer/handle pendente ao importar.
//
// Ao final NÃO chamamos process.exit(0): o processo precisa terminar sozinho (prova de que
// nada ficou pendente). Um alarme `unref` reprova o teste se algo segurar o processo.
//
// Execução: node tests/test-tts-pipeline.js
import assert from 'assert';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const tts = await import(new URL('../src/services/tts/index.js', import.meta.url));
const { createSpeakerManager } = await import(new URL('../src/services/tts/output.js', import.meta.url));
const { createFakeProvider } = await import(new URL('../src/services/tts/providers/fake.js', import.meta.url));
const { FIXED_PHRASES } = await import(new URL('../src/services/tts/segment.js', import.meta.url));
const { setBlocklistForTests } = await import(new URL('../src/services/tts/policy.js', import.meta.url));
const { setLexiconForTests } = await import(new URL('../src/services/tts/normalize.js', import.meta.url));

// Lista de bloqueio e léxico são do dono (editáveis): os testes usam cópias fixas, não os arquivos.
setBlocklistForTests([
  'porra', 'caralho', 'buceta', 'xoxota', 'piroca', 'pirocudo', 'punheta', 'cuzao', 'arrombado', 'arrombada', 'fdp', 'pqp',
  'vsf', 'tnc', 'puta', 'putas', 'putaria', 'putinha', 'viadinho', 'viado', 'bicha', 'traveco', 'sapatao', 'nigger', 'nigga',
  'merda', 'fodase', 'retardado', 'retardada', 'mongoloide', 'crioulo', 'crioula', 'macumbeiro', 'nazista', 'heil',
  'filho da puta', 'filha da puta', 'puta que pariu', 'puta merda', 'vai tomar no cu', 'tomar no cu', 'vai se foder',
  'foda-se', 'vai se matar', 'se mata', 'se mate', 'volta pra senzala', 'sieg heil', 'heil hitler', 'white power', 'poder branco',
]);
setLexiconForTests({ Yui: 'Iúi', Discord: 'Discórdi', GPU: 'gê pê u', CPU: 'cê pê u', IA: 'i á', OK: 'okei' });

const {
  initTts, speakVoiceReply, interruptSpeech, disposeGuild, isSpeaking, overlapsSpeech,
  noteHumanSpeaking, getTtsStatus, warmupTts, shutdownTts, createPcmCache,
} = tts;

const FRAME = 3840;
const BYTES_PER_MS = 192;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FALHA  ${name}\n      ${err.stack || err.message}`);
  }
  await shutdownTts(); // cada caso começa do zero
}

/** Deixa as cadeias de promessas assentarem (setImmediate não é timer pendente). */
async function flush(rounds = 25) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Qualquer exceção/rejeição que escape do módulo reprova o teste em vez de passar despercebida.
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(`uncaughtException: ${e?.code || e?.name}`));
process.on('unhandledRejection', (e) => escaped.push(`unhandledRejection: ${e?.code || e?.name || e}`));

// Se um timer pendente segurar o processo depois do fim, este alarme (unref) avisa e reprova.
const alarm = setTimeout(() => {
  console.log('  FALHA  o processo não terminou sozinho (timer ou handle pendente)');
  process.exit(1);
}, 60_000);
alarm.unref();

// ── Dublês ────────────────────────────────────────────────────────────

const LIB = {
  AudioPlayerStatus: { Idle: 'idle', Buffering: 'buffering', Playing: 'playing', AutoPaused: 'autopaused', Paused: 'paused' },
  VoiceConnectionStatus: {
    Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting', Destroyed: 'destroyed',
  },
  StreamType: { Raw: 'raw' },
  NoSubscriberBehavior: { Pause: 'pause' },
};

/** Relógio falso: `advance` dispara os timers vencidos em ordem, assentando as promessas entre eles. */
function createClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { id, at: t + Math.max(0, ms), fn });
      return { id, unref() { return this; }, ref() { return this; } };
    },
    clearTimeout(handle) {
      timers.delete(handle?.id);
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.values()].filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        t = Math.max(t, due.at);
        due.fn();
        await flush();
      }
      t = target;
      await flush();
    },
    pending: () => timers.size,
  };
}

class FakePlayer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { status: 'idle' };
    this.stops = 0;
  }

  play(resource) {
    const old = this.state;
    this.state = { status: 'playing', resource };
    this.emit('stateChange', old, this.state);
    this.emit('playing', old, this.state);
  }

  end() {
    const old = this.state;
    if (old.status === 'idle') return false;
    this.state = { status: 'idle' };
    this.emit('stateChange', old, this.state);
    this.emit('idle', old, this.state);
    return true;
  }

  stop() {
    if (this.state.status === 'idle') return false;
    this.stops += 1;
    return this.end();
  }
}

class FakeConn extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'ready', subscription: undefined, networking: { state: { dave: null } } };
    Object.defineProperty(this, 'voicePrivacyCode', { get: () => undefined, configurable: true });
  }

  subscribe(player) {
    const sub = {
      player,
      unsubscribe: () => {
        if (this.state.subscription === sub) this.state.subscription = undefined;
      },
    };
    this.state.subscription = sub;
    return sub;
  }
}

const fakeEntersState = (target) => Promise.resolve(target);

/** Provedor que guarda os textos recebidos (só dentro do teste; nada disso vai a log). */
function spyProvider(base, texts) {
  return {
    ...base,
    async synth(text, o) {
      texts.push(text);
      return base.synth(text, o);
    },
  };
}

const SPOKEN_MARK = 'zebrafantasma';

/** Monta o mundo: relógio, gerenciador real com player falso, deps controláveis e logger que guarda tudo. */
function makeWorld({ env = {}, providers, depsOver = {}, client = null, realReadable = false, manager } = {}) {
  const clock = createClock();
  const logs = [];
  const logger = {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
    debug: (m) => logs.push(['debug', String(m)]),
  };
  const st = {
    enabled: true, banned: false, bot: false, radio: false, aiCall: true, inVoice: true, canSpeak: true,
    opus: true, forbidden: () => false, trigger: () => false, names: { 5: 'Maria' },
  };
  const w = { clock, logs, st, players: [], resources: [], readables: [], conn: new FakeConn(), enqueueCalls: 0 };

  const realManager = createSpeakerManager({
    getConnection: () => w.conn,
    createPlayer: (options) => {
      const player = new FakePlayer(options);
      w.players.push(player);
      return player;
    },
    createResource: (readable, options) => {
      // Quem consome o stream (o aquecimento do Opus faz isso) o vê terminar logo, como um stream real curto.
      const playStream = new EventEmitter();
      const on = playStream.on.bind(playStream);
      playStream.on = (event, fn) => {
        on(event, fn);
        if (event === 'data') setImmediate(() => playStream.emit('end'));
        return playStream;
      };
      const resource = { readable, options, playStream };
      w.resources.push(resource);
      return resource;
    },
    entersState: fakeEntersState,
    voiceLib: LIB,
    logger,
    config: { queueMax: 3, staleSeconds: 30, maxSeconds: 25, bargeIn: true, bargeInMs: 800, echoGuardMs: 1500 },
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    isRadioActive: () => st.radio,
    ...(realReadable
      ? {}
      : {
        readableFromPcm: (pcm) => {
          const readable = { pcm, destroy() { this.destroyed = true; } };
          w.readables.push(readable);
          return readable;
        },
      }),
  });
  w.manager = {
    ...realManager,
    enqueue: (guildId, job) => {
      w.enqueueCalls += 1;
      return realManager.enqueue(guildId, job);
    },
  };

  w.deps = {
    isEnabled: () => st.enabled,
    isBanned: () => st.banned,
    isBot: () => st.bot,
    isRadioActive: () => st.radio,
    isAiCallActive: () => st.aiCall,
    isUserInSameVoice: () => st.inVoice,
    canSpeakInChannel: () => st.canSpeak,
    containsForbidden: (text) => st.forbidden(text),
    matchesTrigger: (text) => st.trigger(text),
    resolveName: (guildId, id) => st.names[id] ?? null,
    isOpusAvailable: () => st.opus,
    ...depsOver,
  };

  w.texts = [];
  w.fake = createFakeProvider({ name: 'fake' });
  w.providers = providers ?? [spyProvider(w.fake, w.texts)];

  w.init = (extraOverrides = {}) => initTts({
    client,
    deps: w.deps,
    overrides: {
      env,
      providers: w.providers,
      manager: manager ?? w.manager,
      logger,
      now: clock.now,
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      ...extraOverrides,
    },
  });

  // A transcrição é obrigatória (sem ela a resposta não é falada); o padrão não tem nada a ver com a resposta.
  w.req = (over = {}) => ({
    guildId: 'g1', userId: 'u1', text: 'Está tudo certo por aqui, pode confiar.', sensitive: false,
    requestedAt: clock.now(), fromVoice: true, transcript: 'como anda o servidor hoje', ...over,
  });
  w.logText = () => logs.map(([, m]) => m).join('\n');

  /** Deixa a frase em andamento tocar até o fim: o relógio anda a duração dela e o player vai a Idle. */
  w.endSentence = async () => {
    const player = w.players[0];
    const resource = player.state.resource;
    const readable = w.readables.find((r) => w.resources.find((x) => x.readable === r) === resource);
    await clock.advance(readable.pcm.length / BYTES_PER_MS);
    player.end();
    await flush();
  };
  /** Toca a resposta inteira (até não haver mais frase em andamento). */
  w.playAll = async (max = 12) => {
    await flush();
    for (let i = 0; i < max; i += 1) {
      const player = w.players[0];
      if (!player || player.state.status === 'idle') break;
      await w.endSentence();
    }
    await flush();
  };
  w.playedPcm = () => w.readables.map((r) => r.pcm);
  return w;
}

/** Cria o mundo, liga o TTS e confere que subiu. */
async function boot(opts) {
  const w = makeWorld(opts);
  const r = await w.init();
  assert.strictEqual(r.enabled, true, `initTts deveria ligar (${JSON.stringify(r)})`);
  return w;
}

const noSpeechYet = (w) => {
  const synthCalls = w.fake.stats.synth;
  assert.strictEqual(synthCalls, 0, 'nenhuma síntese');
  assert.strictEqual(w.enqueueCalls, 0, 'nada chegou à fila');
  assert.strictEqual(w.players.length, 0, 'nenhum player foi criado');
};

// ── Higiene do módulo ─────────────────────────────────────────────────

await test('importar index.js não deixa timer, processo nem handle aberto (processo filho termina sozinho)', () => {
  const url = new URL('../src/services/tts/index.js', import.meta.url).href;
  const code = `
    const m = await import(${JSON.stringify(url)});
    const res = process.getActiveResourcesInfo().filter((r) => !['TTYWrap', 'PipeWrap', 'FSReqCallback'].includes(r));
    console.log(JSON.stringify({ exports: Object.keys(m).sort(), res }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: 20_000, encoding: 'utf8', windowsHide: true,
  });
  const data = JSON.parse(out.trim().split('\n').pop());
  for (const name of [
    'initTts', 'speakVoiceReply', 'interruptSpeech', 'disposeGuild', 'isSpeaking', 'overlapsSpeech',
    'noteHumanSpeaking', 'getTtsStatus', 'isParrotRequest', 'isStopCommand', 'wakeWordInFirstWords',
    'echoesInput', 'looksLikeToolJson',
  ]) {
    assert.ok(data.exports.includes(name), `falta o export ${name}`);
  }
  assert.deepStrictEqual(data.res, [], `recursos ativos depois do import: ${data.res.join(',')}`);
});

await test('o código de produção não usa console.* nem executa shell', () => {
  const src = fs.readFileSync(new URL('../src/services/tts/index.js', import.meta.url), 'utf8');
  assert.ok(!/\bconsole\./.test(src), 'index.js usa console.*');
  assert.ok(!/\bexec(?:Sync)?\s*\(/.test(src), 'index.js usa exec');
  assert.ok(!/shell\s*:\s*true/.test(src), 'index.js liga shell');
});

await test('os helpers puros de policy são reexportados e funcionam', () => {
  assert.strictEqual(tts.isParrotRequest('repita depois de mim: oi'), true);
  assert.strictEqual(tts.isStopCommand('Yui, para'), true);
  assert.strictEqual(tts.isStopCommand('para que serve a GPU'), false);
  assert.strictEqual(tts.wakeWordInFirstWords('yui qual a hora', /yui/i, 3), true);
  assert.strictEqual(tts.wakeWordInFirstWords('quero saber se a yui ainda está aí', /yui/i, 3), false);
  assert.strictEqual(tts.looksLikeToolJson('{"tool":"play","args":{}}'), true);
  assert.strictEqual(tts.echoesInput('qual é a capital da frança', 'Paris.'), false);
});

await test('sem iniciar: tudo devolve "desligado" sem lançar', async () => {
  assert.deepStrictEqual(speakVoiceReply({ guildId: 'g', userId: 'u' }), { ok: false, reason: 'tts-off' });
  assert.strictEqual(interruptSpeech('g', 'x'), false);
  assert.strictEqual(disposeGuild('g'), false);
  assert.strictEqual(isSpeaking('g'), false);
  assert.strictEqual(overlapsSpeech('g', 0, 1), false);
  assert.strictEqual(noteHumanSpeaking('g', 'u', true), undefined);
  assert.strictEqual(getTtsStatus().initialized, false);
  assert.strictEqual(await warmupTts(), false);
  assert.strictEqual(await shutdownTts(), false);
});

// ── Ligar e desligar ──────────────────────────────────────────────────

await test('YUI_TTS_ENABLED=false: não faz nada (nem sonda, nem cria player, nem enfileira)', async () => {
  const w = makeWorld({ env: { YUI_TTS_ENABLED: 'false' } });
  const r = await w.init();
  assert.deepStrictEqual(r, { enabled: false, reason: 'disabled' });
  assert.strictEqual(w.fake.stats.probe, 0, 'não sondou');
  assert.strictEqual(w.fake.stats.warmup, 0);
  const res = speakVoiceReply(w.req());
  assert.deepStrictEqual(res, { ok: false, reason: 'tts-off' });
  noSpeechYet(w);
  assert.strictEqual(getTtsStatus().initialized, false);
  assert.strictEqual(getTtsStatus().reason, 'disabled');
});

await test('sem Opus não liga (ausente, false, lançando ou assíncrono)', async () => {
  const variants = {
    ausente: undefined,
    falso: () => false,
    lanca: () => { throw new Error('sem opus'); },
    assincrono: async () => true, // promessa nunca vale como "sim"
  };
  for (const [name, fn] of Object.entries(variants)) {
    const w = makeWorld({ depsOver: { isOpusAvailable: fn } });
    const r = await w.init();
    assert.deepStrictEqual(r, { enabled: false, reason: 'no-opus' }, name);
    assert.strictEqual(w.fake.stats.probe, 0, `${name}: não sondou`);
    assert.deepStrictEqual(speakVoiceReply(w.req()), { ok: false, reason: 'tts-off' }, name);
    noSpeechYet(w);
    await shutdownTts();
  }
  // deps ausente por completo
  const r = await initTts({ client: null, overrides: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  assert.strictEqual(r.enabled, false);
});

await test('Opus que some DEPOIS de ligar também impede a fala (decideSpeak confere sempre)', async () => {
  const w = await boot();
  w.st.opus = false;
  assert.deepStrictEqual(speakVoiceReply(w.req()), { ok: false, reason: 'tts-off' });
  noSpeechYet(w);
});

await test('initTts duas vezes mantém a instância; shutdownTts fecha provedor, gerenciador e permite religar', async () => {
  const w = await boot();
  const again = await w.init();
  assert.strictEqual(again.reason, 'already-initialized');
  assert.strictEqual(w.fake.stats.probe, 1, 'sondou uma vez só');
  assert.strictEqual(await shutdownTts(), true);
  assert.strictEqual(w.fake.stats.dispose, 1, 'o provedor foi fechado');
  assert.deepStrictEqual(speakVoiceReply(w.req()), { ok: false, reason: 'tts-off' });
  const r = await w.init();
  assert.strictEqual(r.enabled, true, 'religa depois do shutdown');
});

await test('provedor cuja sondagem falha sai da cadeia; sem nenhum disponível a Yui fica só em texto', async () => {
  const bad = createFakeProvider({ name: 'ruim', probeOk: false });
  const w = makeWorld({ providers: [bad] });
  const r = await w.init();
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.providers[0].ok, false);
  assert.deepStrictEqual(speakVoiceReply(w.req()), { ok: false, reason: 'tts-off' });
  assert.strictEqual(bad.stats.synth, 0);
  assert.strictEqual(w.enqueueCalls, 0);
  assert.strictEqual(getTtsStatus().engine.providers[0].probe.ok, false);
});

await test('provedor real (SAPI) no boot: só confere o powershell.exe e NÃO sobe processo', async () => {
  const spawned = [];
  const w = makeWorld({ providers: [] });
  const r = await initTts({
    client: null,
    deps: w.deps,
    overrides: {
      env: {}, // sem providers: usa o padrão da configuração (sapi)
      providers: undefined,
      manager: w.manager,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      now: w.clock.now,
      timers: { setTimeout: w.clock.setTimeout, clearTimeout: w.clock.clearTimeout },
      spawn: (...args) => { spawned.push(args); throw new Error('não deveria subir processo no boot'); },
    },
  });
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.providers.length, 1);
  assert.strictEqual(r.providers[0].name, 'sapi');
  assert.strictEqual(r.providers[0].ok, process.platform === 'win32');
  assert.strictEqual(spawned.length, 0, 'nenhum processo no boot');
  const status = getTtsStatus();
  assert.deepStrictEqual(status.config.providers, ['sapi']);
  assert.strictEqual(status.engine.providers[0].local, true);
  await shutdownTts();
});

await test('nomes de provedor ainda não implementados (piper) ou desconhecidos não ligam o TTS sozinhos', async () => {
  const w = makeWorld({ providers: [] });
  const r = await initTts({
    client: null,
    deps: w.deps,
    overrides: {
      env: { YUI_TTS_PROVIDERS: 'piper,xyz' },
      providers: undefined,
      manager: w.manager,
      logger: w.logs && { info: (m) => w.logs.push(['info', m]), warn: (m) => w.logs.push(['warn', m]), error() {}, debug() {} },
    },
  });
  assert.deepStrictEqual(r, { enabled: false, reason: 'no-providers' });
  assert.deepStrictEqual(speakVoiceReply(w.req()), { ok: false, reason: 'tts-off' });
});

await test('initTts nunca lança nem rejeita, mesmo com overrides e logger absurdos', async () => {
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const w = makeWorld();
  const cases = [
    { deps: 'x', overrides: { logger: quiet } },
    { deps: w.deps, overrides: { logger: quiet, providers: 'x', manager: 5 } },
    { deps: w.deps, overrides: { logger: quiet, providers: [null, 1, {}], manager: {} } },
    { deps: w.deps, overrides: { logger: quiet, env: 'x', config: 'y', timers: 3, now: 'z' } },
    { deps: w.deps, overrides: { logger: {}, providers: w.providers, manager: w.manager } },
    { deps: w.deps, overrides: { logger: { info: 3, warn() { throw new Error('log quebrado'); } }, providers: w.providers, manager: w.manager } },
  ];
  for (const arg of cases) {
    let r;
    await assert.doesNotReject(async () => { r = await initTts(arg); });
    assert.strictEqual(typeof r, 'object');
    await shutdownTts();
  }
});

await test('initTts sem argumentos válidos nem logger (logger do projeto, num diretório temporário) não lança', () => {
  // Processo filho com cwd temporário: o logger do projeto grava em ./logs, e este teste não pode
  // sujar os logs de verdade. Também prova que o logger carregado sob demanda funciona de ponta a ponta.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-tts-pipeline-'));
  try {
    const url = new URL('../src/services/tts/index.js', import.meta.url).href;
    const code = `
      import fs from 'node:fs';
      const m = await import(${JSON.stringify(url)});
      const out = [];
      for (const arg of [undefined, null, 42, 'x', [], { deps: 'x', overrides: 7 }, { overrides: { logger: 3, providers: 'x' } }]) {
        try { out.push(JSON.stringify(await m.initTts(arg))); } catch (e) { out.push('LANCOU ' + (e && e.name)); }
      }
      out.push(JSON.stringify(m.speakVoiceReply({ guildId: 'g' })));
      let logged = false;
      for (let i = 0; i < 40 && !logged; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          logged = fs.readdirSync('logs').some((f) => f.startsWith('app-') && fs.readFileSync('logs/' + f, 'utf8').includes('[TTS] Desligado'));
        } catch { /* ainda não existe */ }
      }
      console.log(JSON.stringify({ out, logged }));
      process.exit(0);
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: dir, timeout: 30_000, encoding: 'utf8', windowsHide: true, env: { ...process.env, LOG_LEVEL: 'info' },
    });
    const data = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    assert.ok(!data.out.some((l) => l.startsWith('LANCOU')), data.out.join(' | '));
    assert.ok(data.out.slice(0, 7).every((l) => JSON.parse(l).enabled === false), data.out.join(' | '));
    assert.deepStrictEqual(JSON.parse(data.out[7]), { ok: false, reason: 'tts-off' });
    assert.strictEqual(data.logged, true, 'o logger do projeto gravou a linha de "Desligado"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Caminho feliz ─────────────────────────────────────────────────────

const MD_TEXT = '**Olá** <@5>! Hoje são 14h30 e a GPU está 😀 bem. Aproveite o jogo, valeu!';

await test('Markdown com menção e emoji vira frases limpas e chega ao player como PCM múltiplo de 3840', async () => {
  const w = await boot();
  const res = speakVoiceReply(w.req({ text: MD_TEXT }));
  assert.deepStrictEqual({ ok: res.ok, reason: res.reason, mode: res.mode }, { ok: true, reason: 'queued', mode: 'full' });
  assert.ok(!(res instanceof Promise), 'speakVoiceReply é síncrona');
  assert.strictEqual(isSpeaking('g1'), true, 'a resposta já está em andamento');

  await w.playAll();
  assert.ok(w.texts.length >= 2, `frases sintetizadas: ${JSON.stringify(w.texts)}`);
  const joined = w.texts.join(' ');
  assert.ok(joined.includes('Maria'), 'menção resolvida para o nome');
  assert.ok(joined.includes('catorze e trinta'), 'hora por extenso');
  assert.ok(joined.includes('gê pê u'), 'léxico aplicado');
  for (const text of w.texts) {
    assert.ok(!/[\d*_~|<>#@[\]{}]/.test(text), `sobrou marcação ou dígito: ${text}`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), 'sobrou emoji');
  }
  const pcms = w.playedPcm();
  assert.strictEqual(pcms.length, w.texts.length, 'toda frase chegou ao player');
  for (const pcm of pcms) {
    assert.ok(pcm.length > 0 && pcm.length % FRAME === 0, `PCM de ${pcm.length} bytes não é múltiplo de ${FRAME}`);
  }
  assert.strictEqual(w.players.length, 1, 'um player por servidor');
  assert.strictEqual(w.resources[0].options.inputType, 'raw');
  assert.strictEqual(isSpeaking('g1'), false);

  const line = w.logs.map(([, m]) => m).find((m) => m.startsWith('[TTS] Fala:'));
  assert.ok(line, 'uma linha de log por fala');
  for (const field of ['servidor=g1', 'usuario=u1', 'provedor=fake', 'modo=full', 'ms_pedido_ate_pronto=', 'ms_sintese=', 'ms_primeiro_som=', 'motivo=done']) {
    assert.ok(line.includes(field), `faltou ${field} em: ${line}`);
  }
  assert.strictEqual(w.clock.pending(), 0, 'nenhum timer sobrou');
});

await test('o PCM chega pelo pcmToReadable REAL em pedaços múltiplos de 3840', async () => {
  const w = await boot({ realReadable: true });
  assert.strictEqual(speakVoiceReply(w.req({ text: 'Isso é um teste curto de verdade, tudo bem por aí?' })).ok, true);
  await flush(40);
  assert.strictEqual(w.resources.length, 1);
  const chunks = [];
  for await (const chunk of w.resources[0].readable) chunks.push(chunk);
  assert.ok(chunks.length > 1, 'entregue em vários pedaços');
  for (const c of chunks) assert.strictEqual(c.length % FRAME, 0);
  assert.ok(chunks.every((c) => c.length <= 40 * FRAME), 'pedaços de até 40 quadros');
  w.players[0].end(); // fim natural do recurso: a resposta (1 frase) termina
  await flush();
  assert.strictEqual(isSpeaking('g1'), false);
});

await test('link vira modo pointer: introdução + "Mandei os detalhes no chat."; a URL nunca é falada', async () => {
  const w = await boot();
  const res = speakVoiceReply(w.req({ text: 'Veja https://exemplo.com/abc 🎉 para mais informações sobre isso aqui.' }));
  assert.strictEqual(res.mode, 'pointer');
  await w.playAll();
  assert.deepStrictEqual(w.texts, ['Veja para mais informações sobre isso aqui.', FIXED_PHRASES.details]);
  assert.ok(!w.texts.join(' ').includes('http'));
  for (const pcm of w.playedPcm()) assert.strictEqual(pcm.length % FRAME, 0);
});

await test('só código: não sobra texto, mas fala a frase fixa (nada do código é lido)', async () => {
  const w = await boot();
  const res = speakVoiceReply(w.req({ text: '```js\nconst resultado = soma(2, 3);\n```' }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.mode, 'pointer');
  await w.playAll();
  assert.deepStrictEqual(w.texts, [FIXED_PHRASES.details]);
});

const LONG_TEXT = [
  'Primeiro eu preciso explicar como funciona a configuração inicial do servidor.',
  'Depois disso vem a parte de ajustar as permissões de cada cargo com calma.',
  'Em seguida é preciso conferir os canais de voz que ficam abertos para todos.',
  'Por fim vale revisar as regras de moderação automática antes de convidar o pessoal.',
  'E ainda sobra uma lista enorme de detalhes que não cabe numa fala curta.',
].join(' ');

await test('resposta longa vira modo truncated e termina com "O resto está no chat."', async () => {
  const w = await boot();
  const res = speakVoiceReply(w.req({ text: LONG_TEXT }));
  assert.strictEqual(res.mode, 'truncated');
  await w.playAll();
  assert.ok(w.texts.length >= 2 && w.texts.length <= 4);
  assert.strictEqual(w.texts.at(-1), FIXED_PHRASES.rest);
  assert.ok(!w.texts.join(' ').includes('lista enorme'), 'o resto não foi lido');
  assert.strictEqual(w.playedPcm().length, w.texts.length);
});

await test('frases fixas ficam no cache: a 2ª resposta não sintetiza "O resto está no chat." de novo', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ userId: 'u1', text: LONG_TEXT })).ok, true);
  await w.playAll();
  assert.strictEqual(speakVoiceReply(w.req({ userId: 'u2', text: LONG_TEXT })).ok, true);
  await w.playAll();
  assert.strictEqual(w.texts.filter((t) => t === FIXED_PHRASES.rest).length, 1, 'sintetizada uma única vez');
  const status = getTtsStatus();
  assert.strictEqual(status.fixedCache.entries, 1);
  assert.ok(status.fixedCache.hits >= 1);
  assert.ok(status.fixedCache.bytes > 0 && status.fixedCache.bytes <= status.fixedCache.maxBytes);
  assert.strictEqual(w.playedPcm().filter((p) => p === w.playedPcm().at(-1)).length >= 2, true, 'o mesmo PCM tocou duas vezes');
  assert.strictEqual(status.counters.spoken, 2);
});

await test('nome de menção hostil é sanitizado (sem @, colchetes nem marcação) antes de falar', async () => {
  const w = await boot();
  w.st.names[5] = '@everyone [Zé] <b>**Ze**</b>';
  assert.strictEqual(speakVoiceReply(w.req({ text: 'Oi <@5>, tudo bem com você hoje?' })).ok, true);
  await w.playAll();
  const joined = w.texts.join(' ');
  assert.ok(!/[@[\]<>*]/.test(joined), `sobrou marcação: ${joined}`);
  assert.ok(joined.startsWith('Oi '));
});

await test('sem deps.resolveName usa o cache do cliente; menção desconhecida é removida', async () => {
  const members = new Map([['7', { displayName: 'Joana' }]]);
  const client = { guilds: { cache: new Map([['g1', { members: { cache: members } }]]) } };
  const w = makeWorld({ client, depsOver: { resolveName: undefined } });
  assert.strictEqual((await w.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(w.req({ text: 'Oi <@7> e <@999>, tudo bem com vocês hoje?' })).ok, true);
  await w.playAll();
  const joined = w.texts.join(' ');
  assert.ok(joined.includes('Joana'), joined);
  assert.ok(!joined.includes('999'));
});

// ── Recusas: cada razão não sintetiza nada ────────────────────────────

const REFUSALS = [
  ['not-voice', {}, { fromVoice: false }],
  ['not-voice', {}, { fromVoice: undefined }],
  ['guild-disabled', { enabled: false }],
  ['no-connection', { aiCall: false }],
  ['bot-user', { bot: true }],
  ['banned', { banned: true }],
  ['user-not-in-call', { inVoice: false }],
  ['radio-active', { radio: true }],
  ['sensitive', {}, { sensitive: true }],
  ['sensitive', {}, { sensitive: undefined }],
  ['no-speak-permission', { canSpeak: false }],
  ['stale', {}, { requestedAt: 1 }],
  ['bad-request', {}, { userId: undefined }],
  ['not-speakable', {}, { text: '😀🎉' }],
  ['not-speakable', {}, { text: 42 }],
  ['system-text', {}, { text: '⚠️ Ocorreu um erro ao processar sua solicitação, tente de novo.' }],
  ['pii', {}, { text: 'O e-mail dele é fulano.silva@exemplo.com.br e o resto não importa.' }],
  ['pii', {}, { text: 'O CPF cadastrado é 123.456.789-09, anote aí por favor.' }],
  ['pii', {}, { text: 'Liga para (11) 98765-4321 que ele atende rapidinho.' }],
  ['pii', {}, { text: 'Manda para fulano arroba exemplo ponto com ponto br depois.' }],
  ['pii', {}, { text: 'A senha é um dois três quatro cinco seis sete oito nove ok.' }],
  ['blocked-word', {}, { text: 'Essa porra de jogo é muito difícil de zerar mesmo.' }],
  ['self-trigger', { trigger: (t) => /\byui\b/i.test(t) }, { text: 'A Yui acha que isso é uma boa ideia sim.' }],
  ['tool-json', {}, { text: '{"tool":"play_music","args":{"query":"abc"}}' }],
  ['tool-json', {}, { text: 'Claro! default_api.play_music(query="abc")' }],
  ['json-text', {}, { text: '{"response": "Oi, tudo bem por aqui?"' }],
  ['json-text', {}, { text: '{"foo":"bar","x":1}' }],
  ['json-text', {}, { text: '["Canberra","Sydney"]' }],
  ['echo-of-input', {}, {
    text: 'Você disse que a capital da França fica muito longe daqui, certo?',
    transcript: 'a capital da frança fica muito longe daqui',
  }],
];

for (const [reason, stOver, reqOver] of REFUSALS) {
  await test(`recusa "${reason}" não sintetiza nada${reqOver && Object.keys(reqOver).length ? ` (${Object.keys(reqOver).join(',')})` : ''}`, async () => {
    const w = await boot();
    Object.assign(w.st, stOver || {});
    if (stOver && stOver.forbidden) w.st.forbidden = stOver.forbidden;
    const res = speakVoiceReply(w.req(reqOver || {}));
    assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason }, JSON.stringify(res));
    await flush();
    noSpeechYet(w);
    assert.strictEqual(getTtsStatus().counters.skipped[reason] >= 1, true, 'contou a recusa');
  });
}

await test('lista de bloqueio do banHandler (containsForbidden) só impede de falar', async () => {
  const w = await boot({ depsOver: {} });
  w.st.forbidden = (t) => /segredo/i.test(t);
  const res = speakVoiceReply(w.req({ text: 'Isso é um segredo que ninguém pode saber agora.' }));
  assert.strictEqual(res.reason, 'blocked-word');
  noSpeechYet(w);
});

await test('dado pessoal que só aparece DEPOIS de resolver a menção também bloqueia (texto final)', async () => {
  const w = await boot();
  // Cada apelido sozinho é inofensivo (6 e 4 dígitos), mas lado a lado viram um número de telefone falado.
  w.st.names[5] = '123456';
  w.st.names[6] = '7890';
  const res = speakVoiceReply(w.req({ text: 'Oi <@5> <@6>, tudo bem com você hoje?' }));
  assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'pii' });
  noSpeechYet(w);
});

await test('apelido que é telefone, palavrão disfarçado ou a palavra de ativação é OMITIDO; a resposta segue', async () => {
  const w = await boot();
  w.st.trigger = (text) => /\byui\b/i.test(text); // como o regex de gatilho do voiceHandler
  const casos = [
    ['11987654321', 'telefone'],
    ['pu.ta', 'palavrão com ponto no meio'],
    [`pu${String.fromCharCode(0x200b)}ta`, 'palavrão com caractere invisível'],
    ['p u t a', 'palavrão com letras separadas'],
    ['Yui', 'a palavra de ativação (a Yui falando o próprio nome acionaria o microfone)'],
  ];
  for (const [i, [nome, motivo]] of casos.entries()) {
    w.st.names[7] = nome;
    const antes = w.texts.length;
    const res = speakVoiceReply(w.req({ userId: `u${i}`, text: 'Oi <@7>, tudo bem com você hoje?' }));
    assert.strictEqual(res.ok, true, `${motivo}: a resposta continua (${res.reason})`);
    await w.playAll();
    const falado = w.texts.slice(antes).join(' | ').toLowerCase();
    assert.ok(falado.includes('tudo bem'), `${motivo}: o resto da frase foi falado (${falado})`);
    for (const proibido of ['puta', 'pu ta', '987', 'iúi', 'yui']) {
      assert.ok(!falado.includes(proibido), `${motivo}: não falou "${proibido}" (${falado})`);
    }
  }
  // Apelido comum continua sendo falado.
  w.st.names[7] = 'Maria';
  const antes = w.texts.length;
  speakVoiceReply(w.req({ userId: 'uN', text: 'Oi <@7>, tudo bem com você hoje?' }));
  await w.playAll();
  assert.ok(w.texts.slice(antes).join(' ').includes('Maria'));
});

await test('intervalo por usuário: o 2º pedido seguido é recusado (rate-user-gap) sem sintetizar de novo', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req()).ok, true);
  await w.playAll();
  const before = w.fake.stats.synth;
  const second = speakVoiceReply(w.req());
  assert.deepStrictEqual({ ok: second.ok, reason: second.reason }, { ok: false, reason: 'rate-user-gap' });
  await flush();
  assert.strictEqual(w.fake.stats.synth, before);
  await w.clock.advance(7000);
  assert.strictEqual(speakVoiceReply(w.req()).ok, true, 'depois do intervalo volta a falar');
  await w.playAll();
});

await test('fila recusa (queue-full): devolve a razão e não gasta a cota do usuário', async () => {
  const w = makeWorld({ manager: { enqueue: () => ({ ok: false, reason: 'queue-full' }), disposeAll() {}, getStatus: () => ({ guilds: [], count: 0 }) } });
  assert.strictEqual((await w.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(w.req()).reason, 'queue-full');
  assert.strictEqual(speakVoiceReply(w.req()).reason, 'queue-full', 'não virou rate-user-gap');
  assert.strictEqual(getTtsStatus().counters.accepted, 0);
});

// ── Sticky, corte por duração ─────────────────────────────────────────

const THREE = 'Primeira frase bem comportada do teste. Segunda frase também bem comportada aqui. Terceira frase fecha a resposta toda.';

await test('sticky: se o provedor da resposta cai no meio, PARA sem trocar de voz', async () => {
  const flakyBase = createFakeProvider({ name: 'a' });
  let calls = 0;
  const texts = [];
  const flaky = {
    ...flakyBase,
    async synth(text, o) {
      calls += 1;
      texts.push(text);
      if (calls > 1) throw Object.assign(new Error(`caiu falando ${SPOKEN_MARK}`), { code: 'A_DOWN' });
      return flakyBase.synth(text, o);
    },
  };
  const backup = createFakeProvider({ name: 'b' });
  const w = makeWorld({ providers: [flaky, backup] });
  assert.strictEqual((await w.init()).enabled, true);
  const res = speakVoiceReply(w.req({ text: THREE }));
  assert.strictEqual(res.ok, true);
  assert.ok(res.sentences >= 2);
  await w.playAll();
  assert.strictEqual(backup.stats.synth, 0, 'a voz reserva NÃO assumiu no meio da resposta');
  assert.strictEqual(w.playedPcm().length, 1, 'só a 1ª frase tocou');
  assert.ok(w.logText().includes('motivo=synth-failed'));
  assert.ok(!w.logText().includes(SPOKEN_MARK), 'a mensagem do erro não vai ao log');
});

await test('sticky: falha na 1ª frase pode cair para o reserva, e ele fala a resposta INTEIRA', async () => {
  const bad = createFakeProvider({ name: 'a', mode: 'fail' });
  const backup = createFakeProvider({ name: 'b' });
  const w = makeWorld({ providers: [bad, backup] });
  assert.strictEqual((await w.init()).enabled, true);
  const res = speakVoiceReply(w.req({ text: THREE }));
  assert.strictEqual(res.ok, true);
  await w.playAll();
  assert.strictEqual(bad.stats.synth, 1, 'o provedor ruim só foi tentado na 1ª frase');
  assert.strictEqual(backup.stats.synth, res.sentences);
  assert.strictEqual(w.playedPcm().length, res.sentences);
  assert.ok(w.logText().includes('provedor=b'));
});

await test('uma resposta nova começa sticky do zero (o provedor preferido volta a ser tentado)', async () => {
  const a = createFakeProvider({ name: 'a' });
  const b = createFakeProvider({ name: 'b' });
  const w = makeWorld({ providers: [a, b] });
  assert.strictEqual((await w.init()).enabled, true);
  a.setMode('fail');
  speakVoiceReply(w.req({ userId: 'u1', text: THREE }));
  await w.playAll();
  assert.ok(b.stats.synth >= 1);
  a.setMode('ok');
  const aBefore = a.stats.synth;
  speakVoiceReply(w.req({ userId: 'u2', text: THREE }));
  await w.playAll();
  assert.ok(a.stats.synth > aBefore, 'o provedor A voltou a ser a 1ª opção');
});

await test('soma das durações acima de maxSeconds: corta por frase (nunca no meio) e fecha com "O resto está no chat."', async () => {
  const w = await boot({ env: { YUI_TTS_MAX_SECONDS: '5', YUI_TTS_MAX_CHARS: '600', YUI_TTS_MAX_SENTENCES: '4' } });
  const text = 'Esta é a primeira frase do teste de duração longa. Aqui vem a segunda frase também comprida demais. E por último temos a terceira frase do teste.';
  const res = speakVoiceReply(w.req({ text }));
  assert.strictEqual(res.mode, 'full');
  assert.strictEqual(res.sentences, 3);
  await w.playAll();
  const pcms = w.playedPcm();
  assert.strictEqual(pcms.length, 2, `tocou ${pcms.length} frases`);
  assert.ok(w.texts.includes(FIXED_PHRASES.rest), 'a frase cortada virou o aviso');
  assert.ok(pcms[1].length < pcms[0].length, 'a 2ª que tocou é o aviso curto');
  assert.ok(w.logText().includes('motivo=cut-duration'));
  const totalSeconds = pcms.reduce((s, p) => s + p.length / BYTES_PER_MS, 0) / 1000;
  assert.ok(totalSeconds < 5 + 2, `fala total de ${totalSeconds}s`);
});

await test('interruptor desligado NO MEIO da resposta: para antes da próxima frase (not-allowed)', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ text: THREE })).ok, true);
  await flush();
  assert.strictEqual(w.playedPcm().length, 1);
  w.st.enabled = false;
  await w.endSentence();
  assert.strictEqual(w.playedPcm().length, 1, 'a 2ª frase não tocou');
  assert.ok(w.logText().includes('motivo=not-allowed'));
  assert.strictEqual(isSpeaking('g1'), false);
});

await test('rádio que começa NO MEIO da resposta: para antes da próxima frase', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ text: THREE })).ok, true);
  await flush();
  w.st.radio = true;
  await w.endSentence();
  assert.strictEqual(w.playedPcm().length, 1);
  assert.strictEqual(isSpeaking('g1'), false);
});

// ── Controle: interromper, descartar, janela de eco, barge-in ─────────

await test('interruptSpeech e disposeGuild chegam ao gerenciador; o log guarda o motivo, não o texto', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ text: THREE })).ok, true);
  await flush();
  assert.strictEqual(isSpeaking('g1'), true);
  assert.strictEqual(interruptSpeech('g1', 'user-stop'), true);
  assert.strictEqual(isSpeaking('g1'), false);
  assert.ok(w.players[0].stops >= 1, 'o player parou');
  assert.ok(w.logText().includes('motivo=user-stop'));
  assert.strictEqual(interruptSpeech('g1', 'user-stop'), false, 'nada mais a interromper');
  assert.strictEqual(getTtsStatus().counters.interrupts, 1);

  assert.strictEqual(disposeGuild('g1'), true);
  assert.strictEqual(getTtsStatus().output.count, 0);
  assert.strictEqual(disposeGuild('g1'), false);
  await flush();
});

await test('janela anti-eco e barge-in: só o dono do pedido interrompe, com 800 ms acumulados', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ userId: 'u1', text: THREE })).ok, true);
  await flush();
  const now = w.clock.now();
  assert.strictEqual(overlapsSpeech('g1', now - 100, now + 100), true, 'dentro da fala');
  assert.strictEqual(overlapsSpeech('g1', now - 60_000, now - 50_000), false, 'bem antes');
  assert.strictEqual(overlapsSpeech('outro', now - 100, now + 100), false);

  noteHumanSpeaking('g1', 'u2', true); // outra pessoa falando não interrompe
  await w.clock.advance(1500);
  assert.strictEqual(isSpeaking('g1'), true);
  noteHumanSpeaking('g1', 'u2', false);

  noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(300);
  assert.strictEqual(isSpeaking('g1'), true, '300 ms não bastam');
  await w.clock.advance(600);
  assert.strictEqual(isSpeaking('g1'), false, '900 ms acumulados interrompem');
  assert.ok(w.logText().includes('motivo=barge-in'));
  noteHumanSpeaking('g1', 'u1', false);
  await flush();
});

await test('YUI_TTS_BARGE_IN=false desliga o barge-in', async () => {
  const w = makeWorld({ env: { YUI_TTS_BARGE_IN: 'false' } });
  // o gerenciador de teste já nasce com bargeIn=true; aqui conferimos só o que a configuração diz
  assert.strictEqual((await w.init()).enabled, true);
  assert.strictEqual(getTtsStatus().config.bargeIn, false);
});

// ── Nunca lança, nunca deixa rejeição solta ───────────────────────────

const DEP_REASONS = {
  isOpusAvailable: 'tts-off',
  isEnabled: 'guild-disabled',
  isAiCallActive: 'no-connection',
  isBot: 'bot-user',
  isBanned: 'banned',
  isUserInSameVoice: 'user-not-in-call',
  isRadioActive: 'radio-active',
  canSpeakInChannel: 'no-speak-permission',
  containsForbidden: 'blocked-word',
  matchesTrigger: 'self-trigger',
};

for (const [dep, reason] of Object.entries(DEP_REASONS)) {
  for (const kind of ['lança', 'assíncrona']) {
    await test(`dep ${dep} ${kind}: recusa com "${reason}" sem lançar nem rejeição solta`, async () => {
      const w = await boot();
      w.deps[dep] = kind === 'lança'
        ? () => { throw new Error(`falha ${SPOKEN_MARK}`); }
        : async () => (dep === 'isBot' || dep === 'isBanned' || dep === 'isRadioActive' || dep === 'containsForbidden' || dep === 'matchesTrigger' ? false : true);
      let res;
      assert.doesNotThrow(() => { res = speakVoiceReply(w.req()); });
      assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason });
      await flush();
      noSpeechYet(w);
    });
  }
}

await test('resolveName que lança: a menção some e a Yui fala normalmente', async () => {
  const w = await boot();
  w.deps.resolveName = () => { throw new Error('boom'); };
  const res = speakVoiceReply(w.req({ text: 'Oi <@5>, tudo bem com você hoje?' }));
  assert.strictEqual(res.ok, true);
  await w.playAll();
  assert.ok(!w.texts.join(' ').includes('Maria'));
});

await test('entradas absurdas em speakVoiceReply nunca lançam', async () => {
  const w = await boot();
  const weird = [undefined, null, 0, 'texto', [], () => {}, Symbol('x'), { text: { toString() { throw new Error('x'); } } },
    { guildId: {}, userId: [], text: 'oi', fromVoice: true }, { ...w.req(), text: 'a'.repeat(300_000) }];
  for (const req of weird) {
    let res;
    assert.doesNotThrow(() => { res = speakVoiceReply(req); }, String(typeof req));
    assert.strictEqual(res.ok, false);
  }
  noSpeechYet(w);
});

await test('provedor que rejeita ou lança: a resposta é aceita, nada toca e nenhuma rejeição escapa', async () => {
  const w = await boot({
    providers: [{
      name: 'quebrado', local: true,
      probe: async () => ({ ok: true, detail: 'ok' }),
      warmup: async () => {},
      synth: () => { throw Object.assign(new Error(`erro com ${SPOKEN_MARK}`), { code: 'BROKEN' }); },
      dispose: async () => {},
    }],
  });
  const res = speakVoiceReply(w.req({ text: `Resposta com ${SPOKEN_MARK} para falar em voz alta agora.` }));
  assert.strictEqual(res.ok, true);
  await w.playAll();
  assert.strictEqual(w.players.length, 0, 'nem chegou a criar o player');
  assert.strictEqual(isSpeaking('g1'), false);
  assert.ok(w.logText().includes('motivo=synth-failed'));
  assert.ok(!w.logText().includes(SPOKEN_MARK));
});

await test('provedor devolvendo áudio vazio ou só silêncio: tratado como "não falou"', async () => {
  const empty = createFakeProvider({ name: 'vazio', mode: 'empty' });
  const w = makeWorld({ providers: [empty] });
  assert.strictEqual((await w.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(w.req()).ok, true);
  await w.playAll();
  assert.strictEqual(w.players.length, 0);
  assert.ok(w.logText().includes('motivo=synth-failed'));

  await shutdownTts();
  const silent = {
    name: 'mudo', local: true,
    probe: async () => ({ ok: true, detail: '' }), warmup: async () => {},
    synth: async () => ({ pcm: Buffer.alloc(48000 * 2), sampleRate: 24000, channels: 1 }), // 1 s de zeros
    dispose: async () => {},
  };
  const w2 = makeWorld({ providers: [silent] });
  assert.strictEqual((await w2.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(w2.req()).ok, true);
  await w2.playAll();
  assert.strictEqual(w2.players.length, 0);
});

await test('erro interno inesperado (gerenciador que lança): devolve "error", conta e não vaza a mensagem', async () => {
  const brokenManager = {
    enqueue() { throw new Error(`gerenciador quebrou com ${SPOKEN_MARK}`); },
    disposeAll() {},
    getStatus: () => ({ guilds: [], count: 0 }),
  };
  const w = await boot({ manager: brokenManager });
  let res;
  assert.doesNotThrow(() => { res = speakVoiceReply(w.req({ text: `Falando ${SPOKEN_MARK} bem alto agora mesmo.` })); });
  assert.deepStrictEqual(res, { ok: false, reason: 'error' });
  assert.strictEqual(getTtsStatus().counters.errors, 1);
  assert.ok(w.logText().includes('Erro inesperado'));
  assert.ok(!w.logText().includes(SPOKEN_MARK));
});

await test('privacidade: provedor de nuvem só é usado com YUI_TTS_CLOUD=on e texto NÃO sensível', async () => {
  const build = (env) => {
    const cloud = createFakeProvider({ name: 'nuvem', local: false });
    const local = createFakeProvider({ name: 'local' });
    return { cloud, local, w: makeWorld({ env, providers: [cloud, local] }) };
  };

  // Nuvem desligada (padrão): nem é sondada, nem aquecida, nem chamada.
  const off = build({});
  assert.strictEqual((await off.w.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(off.w.req()).ok, true);
  await off.w.playAll();
  assert.strictEqual(off.cloud.stats.probe + off.cloud.stats.warmup + off.cloud.stats.synth, 0, 'a nuvem não foi tocada');
  assert.ok(off.local.stats.synth >= 1);
  await shutdownTts();

  // Nuvem ligada + texto não sensível: é a 1ª da cadeia.
  const on = build({ YUI_TTS_CLOUD: 'on' });
  assert.strictEqual((await on.w.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(on.w.req()).ok, true);
  await on.w.playAll();
  assert.ok(on.cloud.stats.synth >= 1, 'a nuvem falou');
  assert.strictEqual(on.local.stats.synth, 0);
  await shutdownTts();

  // Nuvem ligada + conteúdo sensível: a fala nem começa (a call é pública), então nada sai.
  const sensitive = build({ YUI_TTS_CLOUD: 'on' });
  assert.strictEqual((await sensitive.w.init()).enabled, true);
  assert.strictEqual(speakVoiceReply(sensitive.w.req({ sensitive: true })).reason, 'sensitive');
  assert.strictEqual(sensitive.cloud.stats.synth + sensitive.local.stats.synth, 0);
});

await test('warmupTts aquece os provedores (uma execução mesmo com chamadas simultâneas) e nunca rejeita', async () => {
  const w = await boot();
  const [a, b] = await Promise.all([warmupTts(), warmupTts()]);
  assert.deepStrictEqual([a, b], [true, true]);
  assert.strictEqual(w.fake.stats.warmup, 1);
  await shutdownTts();

  const exploding = {
    name: 'explode', local: true,
    probe: async () => ({ ok: true, detail: '' }),
    warmup: async () => { throw new Error(`aquece ${SPOKEN_MARK}`); },
    synth: async () => { throw new Error('x'); },
    dispose: async () => {},
  };
  const w2 = makeWorld({ providers: [exploding] });
  assert.strictEqual((await w2.init()).enabled, true);
  assert.strictEqual(typeof (await warmupTts()), 'boolean');
  assert.ok(!w2.logText().includes(SPOKEN_MARK));
});

// ── Status e privacidade dos logs ─────────────────────────────────────

await test('getTtsStatus: provedores, disjuntores e contadores, sem texto', async () => {
  const w = await boot();
  speakVoiceReply(w.req({ text: `Resposta secreta ${SPOKEN_MARK} para o status.` }));
  speakVoiceReply(w.req({ userId: 'u9', text: '⚠️ erro nenhum', fromVoice: false }));
  await w.playAll();
  const status = getTtsStatus();
  assert.strictEqual(status.initialized, true);
  assert.strictEqual(status.enabled, true);
  assert.deepStrictEqual(status.engine.chain, ['fake']);
  assert.strictEqual(status.engine.providers[0].breaker.state, 'closed');
  assert.strictEqual(status.engine.providers[0].successes >= 1, true);
  assert.strictEqual(status.counters.requests, 2);
  assert.strictEqual(status.counters.accepted, 1);
  assert.strictEqual(status.counters.spoken, 1);
  assert.strictEqual(status.counters.skipped['not-voice'], 1);
  assert.strictEqual(status.counters.finished.done, 1);
  const dump = JSON.stringify(status);
  assert.ok(!dump.includes(SPOKEN_MARK) && !dump.includes('secreta'), 'texto no status');
});

await test('NENHUM texto falado, transcrição ou apelido aparece em qualquer log capturado', async () => {
  const secrets = ['quimerabrilhante', 'transcricaosecreta', 'apelidoultrasecreto'];
  const w = await boot();
  w.st.names[5] = secrets[2];
  const sentences = [
    `Olá <@5>, a ${secrets[0]} está pronta para uso agora mesmo.`,
    `Mais uma resposta com ${secrets[0]} que será recusada: fulano@exemplo.com por favor.`,
    `Outra com ${secrets[0]} e um erro: ⚠️ Ocorreu um erro grave.`,
    LONG_TEXT.replace('configuração', secrets[0]),
    `Veja https://exemplo.com/${secrets[0]} para ler ${secrets[0]} depois.`,
  ];
  let i = 0;
  for (const text of sentences) {
    i += 1;
    speakVoiceReply(w.req({ userId: `u${i}`, text, transcript: `${secrets[1]} ${secrets[1]} ${secrets[1]} ${secrets[1]} ${secrets[1]} ${secrets[1]}` }));
    await w.playAll();
  }
  interruptSpeech('g1', 'teste');
  // mais um caminho de erro: provedor que lança com o texto na mensagem
  await shutdownTts();
  const log = w.logText();
  assert.ok(log.length > 0, 'houve logs para conferir');
  for (const s of secrets) assert.ok(!log.includes(s), `vazou "${s}" para o log`);
  assert.ok(!/fulano@exemplo/.test(log) && !/https?:\/\//.test(log), 'vazou dado pessoal/URL');
  // e todas as linhas de fala trazem só metadados
  for (const [, m] of w.logs.filter(([, m]) => m.startsWith('[TTS] Fala:'))) {
    assert.match(m, /^\[TTS\] Fala: servidor=\S+ usuario=\S+ provedor=\S+ modo=\S+ frases=\d+\/\d+ caracteres=\d+ ms_pedido_ate_pronto=\S+ ms_sintese=\d+ ms_primeiro_som=\S+ motivo=\S+$/);
  }
});

// ── Correções da revisão ──────────────────────────────────────────────

await test('texto que a voz não lê (japonês, russo, chinês, árabe, ǆ): não fala e NÃO derruba o provedor para todo mundo', async () => {
  const w = await boot();
  for (const [i, text] of ['こんにちは世界', 'Привет, как дела?', '你好，世界。', 'مرحبا بالعالم', 'ǆ'].entries()) {
    const res = speakVoiceReply(w.req({ userId: `u${i}`, text }));
    assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'not-speakable' }, text);
  }
  noSpeechYet(w);
  const st = getTtsStatus();
  assert.strictEqual(st.engine.providers[0].failures, 0, 'nenhuma falha contada no provedor');
  assert.strictEqual(st.engine.providers[0].breaker.state, 'closed');
  // E logo depois a fala normal funciona (antes: o disjuntor abria por 60 s para todos os servidores).
  assert.strictEqual(speakVoiceReply(w.req({ userId: 'ok1', text: 'Olá, tudo bem com você hoje?' })).ok, true);
  await w.playAll();
  assert.strictEqual(w.playedPcm().length, 1);
  // Mistura com alfabeto latino na maior parte passa (o SAPI pula o que não sabe ler).
  assert.strictEqual(speakVoiceReply(w.req({ userId: 'ok2', text: 'Em japonês se diz こんにちは e significa olá.' })).ok, true);
});

await test('a transcrição é obrigatória: ausente, vazia ou de tipo errado => no-transcript (falha fechada)', async () => {
  const w = await boot();
  for (const [i, transcript] of [undefined, null, '', '   ', 42, [], {}, ['como anda o servidor']].entries()) {
    const res = speakVoiceReply(w.req({ userId: `u${i}`, transcript }));
    assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'no-transcript' }, String(JSON.stringify(transcript)));
  }
  noSpeechYet(w);
  assert.strictEqual(getTtsStatus().counters.skipped['no-transcript'], 8);
  // As outras razões continuam vindo antes (um pedido que não é de voz não ganha 'no-transcript').
  assert.strictEqual(speakVoiceReply(w.req({ fromVoice: false, transcript: undefined })).reason, 'not-voice');
  assert.strictEqual(speakVoiceReply(w.req({ userId: 'z', transcript: 'ok, pode falar' })).ok, true);
});

await test('isBot que devolve undefined/null (membro desconhecido) não libera a fala', async () => {
  for (const unknown of [undefined, null]) {
    const w = await boot({ depsOver: { isBot: () => unknown } });
    assert.strictEqual(speakVoiceReply(w.req()).reason, 'bot-user');
    noSpeechYet(w);
    await shutdownTts();
  }
});

await test('quem pediu é banido ou sai da call ENTRE o pedido e a fala: a frase não sai (not-allowed)', async () => {
  for (const [campo, valor] of [['banned', true], ['inVoice', false]]) {
    const w = await boot();
    assert.strictEqual(speakVoiceReply(w.req({ text: THREE })).ok, true);
    w.st[campo] = valor; // antes da 1ª frase (a síntese ainda está em andamento)
    await w.playAll();
    assert.strictEqual(w.resources.length, 0, `${campo}: nada tocou`);
    assert.strictEqual(getTtsStatus().counters.finished['not-allowed'], 1, campo);
    await shutdownTts();
  }
  // E no meio da resposta (depois da 1ª frase).
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ text: THREE })).ok, true);
  await flush();
  assert.strictEqual(w.playedPcm().length, 1);
  w.st.banned = true;
  await w.endSentence();
  assert.strictEqual(w.playedPcm().length, 1, 'a 2ª frase não tocou');
});

await test('apelido de menção que a lista de bloqueio do banHandler pega também é omitido', async () => {
  const w = await boot({ depsOver: { containsForbidden: (t) => /hitler|p0rn/i.test(t) } });
  w.st.names[7] = 'Hitler';
  const res = speakVoiceReply(w.req({ text: 'Oi <@7>, tudo bem com você hoje?' }));
  assert.strictEqual(res.ok, true);
  await w.playAll();
  assert.ok(!w.texts.join(' ').toLowerCase().includes('hitler'));
  assert.ok(w.texts.join(' ').includes('tudo bem'));
});

await test('getTtsStatus: por padrão só contagens (sem IDs de servidor); { detailed: true } traz a lista', async () => {
  const w = await boot();
  assert.strictEqual(speakVoiceReply(w.req({ guildId: 'guild-12345', text: THREE })).ok, true);
  await flush();
  const brief = getTtsStatus();
  assert.deepStrictEqual(brief.output, { count: 1, speaking: 1, queued: 0 });
  assert.ok(!JSON.stringify(brief).includes('guild-12345'), 'nenhum ID de servidor no status padrão');
  const full = getTtsStatus({ detailed: true });
  assert.strictEqual(full.output.guilds[0].guildId, 'guild-12345');
  assert.deepStrictEqual(getTtsStatus({ detailed: 'sim' }).output, brief.output, 'só `true` exato libera os detalhes');
  assert.deepStrictEqual(getTtsStatus(null).output, brief.output);
});

await test('warmupTts também aquece o codificador Opus do gerenciador (uma vez, mesmo com chamadas simultâneas)', async () => {
  const w = makeWorld();
  let aquecimentos = 0;
  const manager = { ...w.manager, warmup: () => { aquecimentos += 1; return Promise.resolve(true); } };
  assert.strictEqual((await w.init({ manager })).enabled, true);
  const [a, b] = await Promise.all([warmupTts(), warmupTts()]);
  assert.deepStrictEqual([a, b], [true, true]);
  assert.strictEqual(aquecimentos, 1);
  assert.strictEqual(w.fake.stats.warmup, 1);
  await shutdownTts();

  // Aquecimento do gerenciador que falha, lança ou nem existe: warmupTts nunca rejeita.
  for (const warmup of [() => Promise.reject(new Error('x')), () => { throw new Error('y'); }, undefined]) {
    const w2 = makeWorld();
    assert.strictEqual((await w2.init({ manager: { ...w2.manager, warmup } })).enabled, true);
    assert.strictEqual(typeof (await warmupTts()), 'boolean');
    await shutdownTts();
  }
});

await test('shutdownTts descarta o gerenciador, fecha os provedores e limpa o cache; religar funciona', async () => {
  const w = makeWorld();
  let disposeAll = 0;
  const manager = { ...w.manager, disposeAll: (reason) => { disposeAll += 1; return w.manager.disposeAll(reason); } };
  assert.strictEqual((await w.init({ manager })).enabled, true);
  speakVoiceReply(w.req({ text: `${THREE} Mais uma frase para passar do limite de caracteres da resposta.`, userId: 'a' }));
  await w.playAll();
  assert.ok(getTtsStatus().fixedCache.entries >= 1, 'a frase fixa entrou no cache');
  assert.strictEqual(await shutdownTts(), true);
  assert.strictEqual(disposeAll, 1);
  assert.strictEqual(w.fake.stats.dispose, 1);
  assert.strictEqual(getTtsStatus().initialized, false);
  assert.strictEqual(await shutdownTts(), false, 'segunda chamada não faz nada');
  assert.strictEqual(speakVoiceReply(w.req()).reason, 'tts-off');
});

await test('a 1ª frase nunca é cortada pelo limite de duração, mesmo sozinha acima de maxSeconds', async () => {
  const w = await boot({ env: { YUI_TTS_MAX_SECONDS: '5', YUI_TTS_MAX_CHARS: '600', YUI_TTS_MAX_SENTENCES: '4' } });
  const primeira = 'Esta primeira frase é bem comprida de propósito para passar dos cinco segundos do provedor falso mesmo sozinha.';
  const segunda = 'Outra frase curta que já não cabe mais no tempo.';
  assert.strictEqual(speakVoiceReply(w.req({ text: `${primeira} ${segunda}` })).sentences, 2);
  await w.playAll();
  assert.strictEqual(w.texts[0], primeira, 'a 1ª frase foi falada inteira');
  const pcms = w.playedPcm();
  assert.strictEqual(pcms.length, 2, 'a 1ª e o aviso');
  assert.ok(pcms[0].length / BYTES_PER_MS > 5000, 'a 1ª sozinha passa de 5 s e mesmo assim toca');
  assert.ok(w.texts.includes(FIXED_PHRASES.rest));
});

await test('falha no meio da resposta: as frases seguintes NEM chegam ao provedor (nada de síntese à toa)', async () => {
  const base = createFakeProvider({ name: 'fake' });
  let calls = 0;
  const provider = {
    ...base,
    async synth(text, o) {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('falhou'), { code: 'FAKE_FAILURE' });
      return base.synth(text, o);
    },
  };
  const w = await boot({ providers: [provider] });
  assert.strictEqual(speakVoiceReply(w.req({ text: THREE })).ok, true);
  await w.playAll();
  assert.strictEqual(calls, 2, `o provedor foi chamado ${calls} vezes (a 3ª frase não devia nem ser tentada)`);
  assert.strictEqual(w.playedPcm().length, 1);
});

await test('recusas esperadas e frequentes (tts-off, not-voice, guild-disabled) logam no máx. 1 vez a cada 10 min; o contador conta todas', async () => {
  const w = await boot();
  const noLog = () => w.logs.filter(([, m]) => m.includes('motivo=not-voice')).length;
  for (let i = 0; i < 5; i += 1) speakVoiceReply(w.req({ userId: `u${i}`, fromVoice: false }));
  assert.strictEqual(noLog(), 1);
  assert.strictEqual(getTtsStatus().counters.skipped['not-voice'], 5);
  await w.clock.advance(9 * 60_000);
  speakVoiceReply(w.req({ fromVoice: false }));
  assert.strictEqual(noLog(), 1, 'ainda dentro dos 10 min');
  await w.clock.advance(60_001);
  speakVoiceReply(w.req({ fromVoice: false }));
  assert.strictEqual(noLog(), 2, 'passaram 10 min: uma linha nova');
  assert.strictEqual(getTtsStatus().counters.skipped['not-voice'], 7);
  // Já as outras razões logam sempre.
  speakVoiceReply(w.req({ sensitive: true }));
  speakVoiceReply(w.req({ sensitive: true }));
  assert.strictEqual(w.logs.filter(([, m]) => m.includes('motivo=sensitive')).length, 2);
  w.st.enabled = false;
  for (let i = 0; i < 3; i += 1) speakVoiceReply(w.req({ userId: `g${i}` }));
  assert.strictEqual(w.logs.filter(([, m]) => m.includes('motivo=guild-disabled')).length, 1);
});

await test('o limitador do módulo usa relógio monotônico quando o relógio não é injetado', async () => {
  const w = makeWorld();
  assert.strictEqual((await w.init({ now: undefined })).enabled, true);
  const realNow = Date.now;
  try {
    // Sem `now` injetado, a hora do PC não pode mexer nos limites; o prazo do pedido (requestedAt) continua usando-a.
    const t0 = realNow();
    Date.now = () => t0;
    const a = speakVoiceReply({ ...w.req(), requestedAt: t0 });
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    Date.now = () => t0 - 3_600_000; // PC com a hora atrasada 1 h
    const b = speakVoiceReply({ ...w.req(), requestedAt: t0 - 3_600_000 });
    assert.strictEqual(b.reason, 'rate-user-gap', 'o intervalo mínimo por usuário continua valendo');
  } finally {
    Date.now = realNow;
  }
});


// ── Cache LRU ─────────────────────────────────────────────────────────

await test('createPcmCache: LRU com teto de bytes, entradas gigantes ignoradas e estatísticas', () => {
  const cache = createPcmCache(1000);
  const b = (n) => Buffer.alloc(n, 1);
  assert.strictEqual(cache.set('a', b(400)), true);
  assert.strictEqual(cache.set('b', b(400)), true);
  assert.strictEqual(cache.get('a')?.length, 400); // 'a' passa a ser o mais recente
  assert.strictEqual(cache.set('c', b(400)), true); // estoura: sai o mais antigo, que agora é 'b'
  assert.strictEqual(cache.get('b'), null);
  assert.strictEqual(cache.get('a')?.length, 400);
  assert.strictEqual(cache.get('c')?.length, 400);
  assert.strictEqual(cache.set('enorme', b(1001)), false, 'maior que o teto não entra');
  assert.strictEqual(cache.set('vazio', Buffer.alloc(0)), false);
  assert.strictEqual(cache.set('lixo', 'texto'), false);
  assert.strictEqual(cache.set('a', b(100)), true, 'regravar substitui e acerta o total');
  const s = cache.stats();
  assert.strictEqual(s.entries, 2);
  assert.strictEqual(s.bytes, 500);
  assert.strictEqual(s.hits, 3);
  assert.strictEqual(s.misses, 1);
  assert.ok(s.bytes <= s.maxBytes);
  cache.clear();
  assert.deepStrictEqual([cache.stats().entries, cache.stats().bytes], [0, 0]);
  assert.strictEqual(createPcmCache().stats().maxBytes, 20 * 1024 * 1024, 'padrão de 20 MB');
});

// ── Fim ───────────────────────────────────────────────────────────────

await flush(40);
if (escaped.length) {
  failed += 1;
  console.log(`  FALHA  exceções ou rejeições escaparam do módulo: ${escaped.join(' | ')}`);
} else {
  passed += 1;
  console.log('  ok  nenhuma exceção nem unhandledRejection escapou durante todos os testes');
}

console.log(`\n${passed} ok, ${failed} falha(s)`);
if (failed > 0) process.exit(1);
