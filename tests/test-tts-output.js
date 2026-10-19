// Testes da saída de áudio do TTS (GuildSpeaker / createSpeakerManager), sem Discord e sem rede.
//
// Conexão, player e recurso são dublês, e o relógio e os timers são falsos: nenhuma espera
// real (as esperas de 8 s, 30 s etc. "passam" em milissegundos). Só o último teste usa o
// AudioPlayer REAL do @discordjs/voice (com uma conexão falsa que recebe os pacotes) para
// provar o contrato do evento Idle; ele leva ~1 s de relógio real.
//
// Ao final NÃO chamamos process.exit(0): o processo precisa terminar sozinho, o que prova que
// nenhum timer ficou pendente. Um alarme `unref` reprova o teste se algo segurar o processo.
//
// Execução: node tests/test-tts-output.js
import assert from 'assert';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { createRequire } from 'module';

const { createSpeakerManager, OUTPUT_LIMITS } = await import(new URL('../src/services/tts/output.js', import.meta.url));

const FRAME = 3840;
const BYTES_PER_MS = 192;

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FALHA  ${name}\n      ${err.stack || err.message}`);
  }
}

/** Deixa as cadeias de promessas assentarem (setImmediate não é timer falso nem real pendente). */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Uma exceção/rejeição que escape do módulo reprova o teste em vez de derrubar o processo.
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(`uncaughtException: ${e?.code || e?.name}`));
process.on('unhandledRejection', (e) => escaped.push(`unhandledRejection: ${e?.code || e?.name || e}`));

// Se um timer pendente segurar o processo depois do fim, este alarme (unref) avisa e reprova.
const alarm = setTimeout(() => {
  console.log('  FALHA  o processo não terminou sozinho (timer pendente)');
  process.exit(1);
}, 40_000);
alarm.unref();

// ── Dublês ────────────────────────────────────────────────────────────

const LIB = {
  AudioPlayerStatus: { Idle: 'idle', Buffering: 'buffering', Playing: 'playing', AutoPaused: 'autopaused', Paused: 'paused' },
  VoiceConnectionStatus: {
    Ready: 'ready',
    Disconnected: 'disconnected',
    Signalling: 'signalling',
    Connecting: 'connecting',
    Destroyed: 'destroyed',
  },
  StreamType: { Raw: 'raw' },
  NoSubscriberBehavior: { Pause: 'pause' },
};

/** Relógio falso: `advance` dispara os timers vencidos em ordem, assentando as promessas entre eles. */
function createClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const handles = [];
  return {
    handles,
    now: () => t,
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { id, at: t + Math.max(0, ms), fn });
      const handle = {
        id,
        unrefCalled: false,
        unref() { this.unrefCalled = true; return this; },
        ref() { return this; },
      };
      handles.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle?.id);
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter((x) => x.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
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
    this.played = [];
    this.stops = 0;
    this.autoPlay = true; // false: fica em Buffering até becomePlaying()
    this.asyncIdle = false; // true: o Idle do stop() só sai em flushIdles()
    this.deferredIdles = [];
  }

  play(resource) {
    const old = this.state;
    this.played.push(resource);
    this.state = { status: this.autoPlay ? 'playing' : 'buffering', resource };
    this.emit('stateChange', old, this.state);
    if (this.autoPlay) this.emit('playing', old, this.state);
  }

  becomePlaying() {
    const old = this.state;
    this.state = { status: 'playing', resource: old.resource };
    this.emit('playing', old, this.state);
  }

  /** Fim natural do recurso (ou stop): o player vai a Idle e emite o evento. */
  end() {
    const old = this.state;
    if (old.status === 'idle') return false;
    this.state = { status: 'idle' };
    const fire = () => {
      this.emit('stateChange', old, this.state);
      this.emit('idle', old, this.state);
    };
    if (this.asyncIdle) this.deferredIdles.push(fire);
    else fire();
    return true;
  }

  stop() {
    if (this.state.status === 'idle') return false;
    this.stops += 1;
    return this.end();
  }

  flushIdles() {
    for (const fire of this.deferredIdles.splice(0)) fire();
  }
}

class FakeConn extends EventEmitter {
  constructor({ dave = null, withPrivacyApi = true } = {}) {
    super();
    this.state = { status: 'ready', subscription: undefined, networking: { state: { dave } } };
    this.subscribed = [];
    this.unsubscribed = [];
    this.code = undefined;
    if (withPrivacyApi) {
      Object.defineProperty(this, 'voicePrivacyCode', { get: () => this.code, configurable: true });
    }
  }

  subscribe(player) {
    const sub = {
      player,
      unsubscribe: () => {
        if (this.state.subscription === sub) this.state.subscription = undefined;
        this.unsubscribed.push(player);
      },
    };
    this.state.subscription = sub;
    this.subscribed.push(player);
    return sub;
  }

  setStatus(status) {
    this.state.status = status;
    this.emit(status);
  }
}

/** entersState falso (mesma assinatura do real: alvo, status, número de ms OU AbortSignal). */
function createFakeEntersState(clock) {
  return (target, status, timeoutOrSignal) =>
    new Promise((resolve, reject) => {
      if (target.state.status === status) {
        resolve(target);
        return;
      }
      let timer = null;
      let signal = null;
      const cleanup = () => {
        target.off(status, onEvent);
        if (timer) clock.clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onEvent = () => {
        cleanup();
        resolve(target);
      };
      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error('abortado'), { name: 'AbortError' }));
      };
      if (typeof timeoutOrSignal === 'number') {
        timer = clock.setTimeout(onAbort, timeoutOrSignal);
      } else {
        signal = timeoutOrSignal;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      target.on(status, onEvent);
    });
}

const DEFAULT_CONFIG = {
  queueMax: 3,
  staleSeconds: 30,
  maxSeconds: 25,
  bargeIn: true,
  bargeInMs: 800,
  echoGuardMs: 1500,
};

function makeWorld({ config = {}, deps = {} } = {}) {
  const clock = createClock();
  const logs = [];
  const logger = {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
    debug: (m) => logs.push(['debug', String(m)]),
  };
  const w = {
    clock,
    logs,
    players: [],
    resources: [],
    readables: [],
    conns: new Map(),
    radio: new Set(),
  };
  w.mgr = createSpeakerManager({
    getConnection: (guildId) => w.conns.get(guildId) ?? null,
    createPlayer: (options) => {
      const player = new FakePlayer(options);
      w.players.push(player);
      return player;
    },
    createResource: (readable, options) => {
      const resource = { readable, options, playStream: new EventEmitter() };
      w.resources.push(resource);
      return resource;
    },
    entersState: createFakeEntersState(clock),
    voiceLib: LIB,
    logger,
    config: { ...DEFAULT_CONFIG, ...config },
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    isRadioActive: (guildId) => w.radio.has(guildId),
    readableFromPcm: (pcm) => {
      const readable = { pcm, destroy() { this.destroyed = true; } };
      w.readables.push(readable);
      return readable;
    },
    ...deps,
  });

  w.addConn = (guildId, options) => {
    const conn = new FakeConn(options);
    w.conns.set(guildId, conn);
    return conn;
  };
  /** Cada frase tem um tamanho distinto: o id (frames) identifica job e índice. */
  w.playedIds = () => w.readables.map((r) => r.pcm.length / FRAME);
  w.logText = () => logs.map(([, m]) => m).join('\n');

  let seq = 0;
  w.job = (opts = {}) => {
    const base = 10 + seq * 20;
    seq += 1;
    const job = {
      userId: opts.userId ?? 'u1',
      count: opts.count ?? 2,
      requestedAt: opts.requestedAt ?? clock.now(),
      calls: [],
      finishes: [],
      pending: new Map(),
      base,
      id: (i) => base + i,
      pcm: (i) => Buffer.alloc(FRAME * (base + i)),
    };
    job.synth = (index, signal) => {
      job.calls.push({ index, signal });
      if (opts.synth) return opts.synth(index, signal, job);
      if (!opts.manual) return Promise.resolve(job.pcm(index));
      return new Promise((resolve, reject) => {
        job.pending.set(index, { resolve, reject });
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('abortado'), { code: 'ABORTED' }));
        }, { once: true });
      });
    };
    job.resolve = (i) => job.pending.get(i).resolve(job.pcm(i));
    job.reject = (i, err) => job.pending.get(i).reject(err);
    job.onFinish = (info) => {
      job.finishes.push(info);
      opts.onFinish?.(info);
    };
    if (opts.canSpeak) job.canSpeak = opts.canSpeak;
    return job;
  };

  /** Deixa a frase em andamento tocar até o fim: o relógio anda a duração dela e o player vai a Idle. */
  w.endSentence = async (player = w.players[0]) => {
    const resource = player.state.resource;
    const readable = w.readables.find((r) => w.resources.find((x) => x.readable === r) === resource);
    await clock.advance(readable.pcm.length / BYTES_PER_MS);
    player.end();
    await flush();
  };
  return w;
}

const reasons = (job) => job.finishes.map((f) => f.reason);

// ── Ordem, prefetch, Idle ─────────────────────────────────────────────

await test('toca as frases em ordem e encadeia no Idle; onFinish traz os números certos', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 3 });
  const res = w.mgr.enqueue('g1', job);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
  await flush();
  assert.deepStrictEqual(w.playedIds(), [job.id(0)]);
  assert.strictEqual(w.players.length, 1, 'um player por servidor');
  assert.strictEqual(w.players[0].options.behaviors.noSubscriber, 'pause');
  assert.strictEqual(w.players[0].options.behaviors.maxMissedFrames, 5);
  assert.strictEqual(w.resources[0].options.inputType, 'raw');

  await w.endSentence();
  assert.deepStrictEqual(w.playedIds(), [job.id(0), job.id(1)]);
  await w.endSentence();
  assert.deepStrictEqual(w.playedIds(), [job.id(0), job.id(1), job.id(2)]);
  assert.strictEqual(job.finishes.length, 0, 'ainda não acabou');
  await w.endSentence();

  assert.deepStrictEqual(reasons(job), ['done']);
  assert.strictEqual(job.finishes[0].sentencesPlayed, 3);
  assert.strictEqual(job.finishes[0].sentencesTotal, 3);
  assert.strictEqual(job.finishes[0].spokenMs, (job.id(0) + job.id(1) + job.id(2)) * 20);
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.strictEqual(w.conns.get('g1').subscribed.length, 1, 'assina uma vez só quando nada muda');
  assert.strictEqual(w.clock.pending(), 0, 'nenhum timer sobrou');
});

await test('prefetch: sintetiza até 2 frases à frente e o recurso só nasce na hora de tocar', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 5 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.deepStrictEqual(job.calls.map((c) => c.index), [0, 1, 2], 'frases 0..2 já pedidas');
  assert.strictEqual(w.resources.length, 1, 'só 1 recurso: o da frase que toca');
  assert.strictEqual(w.readables.length, 1);

  await w.endSentence();
  assert.deepStrictEqual(job.calls.map((c) => c.index), [0, 1, 2, 3]);
  assert.strictEqual(w.resources.length, 2);
  await w.endSentence();
  assert.deepStrictEqual(job.calls.map((c) => c.index), [0, 1, 2, 3, 4]);
  assert.strictEqual(w.resources.length, 3);
  assert.strictEqual(job.calls.filter((c) => c.index === 3).length, 1, 'nenhuma frase é sintetizada duas vezes');
});

await test('frase seguinte ainda em síntese: espera e toca quando fica pronta (antes de 8 s)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 2, manual: true });
  w.mgr.enqueue('g1', job);
  await flush();
  job.resolve(0);
  await flush();
  assert.strictEqual(w.resources.length, 1);
  await w.endSentence();
  assert.strictEqual(w.resources.length, 1, 'frase 1 não está pronta: não toca');
  await w.clock.advance(3000);
  job.resolve(1);
  await flush();
  assert.strictEqual(w.resources.length, 2);
  await w.endSentence();
  assert.deepStrictEqual(reasons(job), ['done']);
});

await test('frase seguinte que não fica pronta em 8 s encerra a resposta e aborta a síntese', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 2, manual: true });
  w.mgr.enqueue('g1', job);
  await flush();
  job.resolve(0);
  await flush();
  await w.endSentence();
  await w.clock.advance(OUTPUT_LIMITS.nextSentenceWaitMs - 1);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true, 'ainda dentro dos 8 s');
  await w.clock.advance(2);
  assert.deepStrictEqual(reasons(job), ['next-sentence-timeout']);
  assert.strictEqual(job.finishes[0].sentencesPlayed, 1);
  assert.strictEqual(job.calls[1].signal.aborted, true, 'a síntese pendente foi abortada');
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
});

await test('1ª frase falha: encerra sem tocar, segue a fila e não vaza a mensagem do erro no log', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const bad = w.job({
    userId: 'u1',
    synth: () => Promise.reject(Object.assign(new Error('TEXTO-FALADO-SECRETO'), { code: 'SAPI_EXIT' })),
  });
  const next = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', bad);
  w.mgr.enqueue('g1', next);
  await flush();
  assert.deepStrictEqual(reasons(bad), ['synth-failed']);
  assert.strictEqual(bad.finishes[0].sentencesPlayed, 0);
  assert.deepStrictEqual(w.playedIds(), [next.id(0)], 'a fila continuou');
  assert.ok(w.logText().includes('SAPI_EXIT'), 'o código do erro vai ao log');
  assert.ok(!w.logText().includes('SECRETO'), 'a message crua nunca vai ao log');
});

await test('PCM vazio ou curto demais da síntese conta como falha', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const empty = w.job({ synth: () => Promise.resolve(Buffer.alloc(0)) });
  const nul = w.job({ userId: 'u2', synth: () => Promise.resolve(null) });
  w.mgr.enqueue('g1', empty);
  w.mgr.enqueue('g1', nul);
  await flush();
  assert.deepStrictEqual(reasons(empty), ['synth-failed']);
  assert.deepStrictEqual(reasons(nul), ['synth-failed']);
  assert.strictEqual(w.resources.length, 0);
});

// ── Fila ──────────────────────────────────────────────────────────────

await test('fila máxima: com a fila cheia o MAIS ANTIGO que espera é descartado', async () => {
  const w = makeWorld(); // queueMax 3: 1 tocando + 2 esperando
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 1 });
  const b = w.job({ userId: 'u2', count: 1 });
  const c = w.job({ userId: 'u3', count: 1 });
  const d = w.job({ userId: 'u4', count: 1 });
  assert.strictEqual(w.mgr.enqueue('g1', a).ok, true);
  assert.strictEqual(w.mgr.enqueue('g1', b).ok, true);
  assert.strictEqual(w.mgr.enqueue('g1', c).ok, true);
  const last = w.mgr.enqueue('g1', d);
  assert.strictEqual(last.ok, true);
  assert.strictEqual(last.dropped, 1);
  assert.deepStrictEqual(reasons(b), ['overflow'], 'b era o mais antigo esperando');
  assert.strictEqual(b.finishes[0].sentencesPlayed, 0);
  assert.strictEqual(b.calls.length, 0, 'nem chegou a sintetizar');
  assert.strictEqual(w.mgr.getStatus().guilds[0].queued, 2);
  await flush();
  await w.endSentence();
  await w.endSentence();
  await w.endSentence();
  assert.deepStrictEqual(w.playedIds(), [a.id(0), c.id(0), d.id(0)], 'a, c, d na ordem; b nunca');
});

await test('fila de tamanho 1: sem ninguém esperando para descartar, o novo é recusado', async () => {
  const w = makeWorld({ config: { queueMax: 1 } });
  w.addConn('g1');
  assert.strictEqual(w.mgr.enqueue('g1', w.job({ userId: 'u1' })).ok, true);
  const refused = w.mgr.enqueue('g1', w.job({ userId: 'u2' }));
  assert.deepStrictEqual({ ok: refused.ok, reason: refused.reason }, { ok: false, reason: 'queue-full' });
});

await test('no máx. 1 pendente por usuário: o pedido novo substitui o antigo (o que toca fica)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const playing = w.job({ userId: 'u1', count: 1 });
  const old2 = w.job({ userId: 'u2', count: 1 });
  const new2 = w.job({ userId: 'u2', count: 1 });
  const again1 = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', playing);
  w.mgr.enqueue('g1', old2);
  w.mgr.enqueue('g1', new2);
  assert.deepStrictEqual(reasons(old2), ['replaced']);
  assert.strictEqual(w.mgr.getStatus().guilds[0].queued, 1);
  w.mgr.enqueue('g1', again1); // u1 já está tocando: não é "pendente", então entra na fila
  assert.deepStrictEqual(reasons(playing), []);
  assert.strictEqual(w.mgr.getStatus().guilds[0].queued, 2);
  await flush();
  for (let i = 0; i < 3; i += 1) await w.endSentence();
  assert.deepStrictEqual(w.playedIds(), [playing.id(0), new2.id(0), again1.id(0)]);
});

await test('validade: pedido velho na retirada é descartado sem sintetizar', async () => {
  const w = makeWorld({ config: { maxSeconds: 120 } });
  w.addConn('g1');
  const first = w.job({ userId: 'u1', count: 1 });
  const stale = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', first);
  w.mgr.enqueue('g1', stale); // requestedAt = agora
  await flush();
  await w.clock.advance(31_000); // `first` continua tocando; `stale` esperando
  const fresh = w.job({ userId: 'u3', count: 1 }); // pedido novo (requestedAt = agora)
  w.mgr.enqueue('g1', fresh);
  w.players[0].end();
  await flush();
  assert.deepStrictEqual(reasons(stale), ['stale']);
  assert.strictEqual(stale.calls.length, 0);
  assert.deepStrictEqual(w.playedIds(), [first.id(0), fresh.id(0)]);
});

await test('validade: pedido já velho ao entrar numa fila vazia é descartado na retirada', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ requestedAt: w.clock.now() - 31_000 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.deepStrictEqual(reasons(job), ['stale']);
  assert.strictEqual(job.calls.length, 0);
  assert.strictEqual(w.players.length, 0, 'nem criou player');
});

await test('enqueue valida o job e nunca lança', async () => {
  const w = makeWorld();
  w.addConn('g1');
  for (const bad of [null, undefined, {}, { synth: () => null }, { synth: () => null, count: 0 }, { synth: 1, count: 1 }, { synth: () => null, count: 999 }]) {
    const r = w.mgr.enqueue('g1', bad);
    assert.deepStrictEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'invalid-job' });
  }
  assert.strictEqual(w.mgr.enqueue('', w.job()).ok, false);
  assert.strictEqual(w.mgr.enqueue(undefined, w.job()).reason, 'invalid-guild');
  assert.strictEqual(w.mgr.getStatus().count, 0, 'recusar não cria servidor');
});

await test('onFinish que lança não quebra a fila', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 1, onFinish: () => { throw new Error('boom'); } });
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  await flush();
  await w.endSentence();
  await w.endSentence();
  assert.deepStrictEqual(w.playedIds(), [a.id(0), b.id(0)]);
  assert.deepStrictEqual(reasons(b), ['done']);
  assert.ok(!w.logText().includes('boom'), 'a message do erro não vai ao log');
});

await test('servidores são independentes (cada um com seu player e sua fila)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.addConn('g2');
  const a = w.job({ userId: 'u1', count: 2 });
  const b = w.job({ userId: 'u1', count: 2 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g2', b);
  await flush();
  assert.strictEqual(w.players.length, 2);
  assert.notStrictEqual(w.conns.get('g1').subscribed[0], w.conns.get('g2').subscribed[0]);
  assert.strictEqual(w.mgr.interrupt('g1', 'x'), true);
  assert.deepStrictEqual(reasons(a), ['x']);
  assert.deepStrictEqual(reasons(b), []);
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.strictEqual(w.mgr.isSpeaking('g2'), true);
  assert.strictEqual(w.mgr.interrupt('g3', 'x'), false, 'servidor sem fala: nada a interromper');
});

await test('canSpeak (gate por frase) encerra a resposta quando passa a negar', async () => {
  const w = makeWorld();
  w.addConn('g1');
  let allowed = true;
  const job = w.job({ count: 3, canSpeak: () => allowed });
  w.mgr.enqueue('g1', job);
  await flush();
  allowed = false; // interruptor desligado no meio
  await w.endSentence();
  assert.deepStrictEqual(reasons(job), ['not-allowed']);
  assert.strictEqual(job.finishes[0].sentencesPlayed, 1);
  assert.strictEqual(w.resources.length, 1);
});

// ── Interrupção e geração ─────────────────────────────────────────────

await test('interrupt limpa tudo, aborta a síntese e para o player; depois funciona de novo', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 3, manual: true });
  const b = w.job({ userId: 'u2', count: 1 });
  const c = w.job({ userId: 'u3', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  w.mgr.enqueue('g1', c);
  await flush();
  a.resolve(0);
  await flush();
  assert.strictEqual(w.resources.length, 1);

  assert.strictEqual(w.mgr.interrupt('g1', 'barge-in'), true);
  assert.deepStrictEqual(reasons(a), ['barge-in']);
  assert.deepStrictEqual(reasons(b), ['barge-in']);
  assert.deepStrictEqual(reasons(c), ['barge-in']);
  assert.strictEqual(a.finishes[0].sentencesTotal, 3);
  assert.ok(a.calls.every((call) => call.signal.aborted), 'todas as sínteses em curso foram abortadas');
  assert.strictEqual(w.players[0].stops, 1);
  assert.strictEqual(w.players[0].state.status, 'idle');
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.strictEqual(w.mgr.getStatus().guilds[0].queued, 0);
  await flush();
  assert.ok(!w.logText().includes('Síntese falhou'), 'abortar não é falha de síntese');
  assert.strictEqual(w.resources.length, 1, 'nada novo tocou depois da interrupção');

  const d = w.job({ userId: 'u4', count: 1 });
  assert.strictEqual(w.mgr.enqueue('g1', d).ok, true);
  await flush();
  assert.deepStrictEqual(w.playedIds(), [a.id(0), d.id(0)], 'estado limpo: a fala seguinte toca normalmente');
});

await test('GERAÇÃO: o Idle síncrono do stop() não toca a próxima frase nem a próxima resposta', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 3 });
  const b = w.job({ userId: 'u2', count: 2 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  await flush();
  w.mgr.interrupt('g1', 'user-stop'); // player.stop(true) emite Idle na hora, com o estado antigo ainda visível
  await flush();
  assert.deepStrictEqual(w.playedIds(), [a.id(0)], 'nem a frase 1 de a nem a resposta b tocaram');
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
});

await test('GERAÇÃO: Idle atrasado da resposta cancelada não avança a resposta nova', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 3 });
  const b = w.job({ userId: 'u2', count: 3 });
  w.mgr.enqueue('g1', a);
  await flush();
  const player = w.players[0];
  player.asyncIdle = true; // o Idle do stop() só chega depois
  w.mgr.interrupt('g1', 'user-stop');
  w.mgr.enqueue('g1', b); // a resposta nova começa a tocar antes do Idle velho chegar
  await flush();
  assert.deepStrictEqual(w.playedIds(), [a.id(0), b.id(0)]);
  assert.strictEqual(player.deferredIdles.length, 1);

  player.flushIdles(); // chega o Idle do recurso de `a`
  await flush();
  assert.deepStrictEqual(w.playedIds(), [a.id(0), b.id(0)], 'o Idle velho NÃO tocou a frase 1 de b');
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);

  player.asyncIdle = false;
  await w.endSentence(player); // o Idle legítimo de b encadeia normalmente
  assert.deepStrictEqual(w.playedIds(), [a.id(0), b.id(0), b.id(1)]);
});

await test('interrupt cancela as esperas na hora (síntese que ignora o abort não deixa timer de 20 s)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  // Esta síntese NUNCA termina nem reage ao abort: só o cancelamento do speaker solta a espera.
  const job = w.job({ synth: () => new Promise(() => {}) });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.ok(w.clock.pending() >= 1, 'há a espera da 1ª frase');
  w.mgr.interrupt('g1', 'user-stop');
  assert.strictEqual(w.clock.pending(), 0, 'o timer da espera foi cancelado na hora');
  await flush();
  assert.deepStrictEqual(reasons(job), ['user-stop']);
  assert.strictEqual(w.resources.length, 0);
});

await test('GERAÇÃO: interromper conta no status; interrupção sem nada em andamento não conta', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.enqueue('g1', w.job({ count: 2 }));
  await flush();
  const before = w.mgr.getStatus().guilds[0].generation;
  assert.strictEqual(w.mgr.interrupt('g1', 'a'), true);
  assert.strictEqual(w.mgr.getStatus().guilds[0].generation, before + 1);
  assert.strictEqual(w.mgr.interrupt('g1', 'b'), false, 'nada para interromper');
  assert.strictEqual(w.mgr.getStatus().guilds[0].generation, before + 1);
});

await test('interrupção enquanto o PCM vira Readable (assíncrono): não toca e solta o stream', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const readables = [];
  const w = makeWorld({
    deps: {
      readableFromPcm: async (pcm) => {
        await gate;
        const readable = { pcm, destroy() { this.destroyed = true; } };
        readables.push(readable);
        return readable;
      },
    },
  });
  w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.strictEqual(readables.length, 0, 'ainda preparando o stream');
  w.mgr.interrupt('g1', 'user-stop');
  release();
  await flush();
  assert.strictEqual(readables.length, 1);
  assert.strictEqual(readables[0].destroyed, true, 'o stream órfão foi destruído');
  assert.strictEqual(w.resources.length, 0, 'nenhum recurso nasceu');
  assert.strictEqual(w.players[0].played.length, 0);
});

await test('createResource que lança (ex.: falta o Opus): encerra com "error", segue a fila e não vaza a mensagem', async () => {
  let fail = true;
  const w = makeWorld({
    deps: {
      createResource: (readable, options) => {
        if (fail) throw Object.assign(new Error('Cannot find module opusscript TEXTO-SECRETO'), { code: 'MODULE_NOT_FOUND' });
        return { readable, options, playStream: new EventEmitter() };
      },
    },
  });
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', a);
  await flush();
  assert.deepStrictEqual(reasons(a), ['error']);
  assert.strictEqual(w.readables[0].destroyed, true, 'o stream não vira lixo pendurado');
  assert.ok(w.logText().includes('MODULE_NOT_FOUND'));
  assert.ok(!w.logText().includes('SECRETO'));
  fail = false;
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', b);
  await flush();
  assert.strictEqual(w.players[0].played.length, 1, 'a fala seguinte toca normalmente');
});

await test('todo timer criado recebe unref (nada segura o processo)', async () => {
  const w = makeWorld({ config: { maxSeconds: 60 } });
  const conn = w.addConn('g1', { dave: { protocolVersion: 1 } });
  const job = w.job({ userId: 'u1', count: 2, manual: true });
  w.mgr.enqueue('g1', job); // espera da 1ª frase
  await flush();
  job.resolve(0);
  await flush(); // espera do DAVE (sleep de 100 ms)
  await w.clock.advance(200);
  conn.code = 'ok';
  await w.clock.advance(100); // toca: watchdog
  w.players[0].autoPlay = false;
  w.mgr.noteHumanSpeaking('g1', 'u1', true); // timer do barge-in
  conn.setStatus('disconnected'); // timer de reconexão
  await flush();
  conn.setStatus('signalling');
  await flush();
  conn.setStatus('ready');
  await w.endSentence(); // frase 1 espera síntese (waitFor)
  job.resolve(1);
  await flush(); // frase em Buffering: timer de Buffering
  assert.ok(w.clock.handles.length >= 6, `timers criados: ${w.clock.handles.length}`);
  assert.ok(w.clock.handles.every((h) => h.unrefCalled), 'algum timer ficou sem unref');
  w.mgr.disposeAll();
  assert.strictEqual(w.clock.pending(), 0);
});

await test('watchdog: fala acima de maxSeconds + 5 s é interrompida (e a fila limpa)', async () => {
  const w = makeWorld({ config: { maxSeconds: 10 } });
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 2 });
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  await flush(); // a frase nunca recebe Idle
  await w.clock.advance(14_999);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
  await w.clock.advance(2);
  assert.deepStrictEqual(reasons(a), ['watchdog']);
  assert.deepStrictEqual(reasons(b), ['watchdog']);
  assert.strictEqual(w.players[0].stops, 1);
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.ok(w.logText().includes('Watchdog'));
  assert.strictEqual(w.clock.pending(), 0, 'o watchdog não deixa timer para trás');
});

await test('watchdog só conta a partir do 1º som (síntese lenta não dispara)', async () => {
  const w = makeWorld({ config: { maxSeconds: 10 } });
  w.addConn('g1');
  const job = w.job({ count: 1, manual: true });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(14_000); // síntese demorou, mas ainda não falou
  job.resolve(0);
  await flush();
  await w.clock.advance(14_000);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
  await w.clock.advance(1_100);
  assert.deepStrictEqual(reasons(job), ['watchdog']);
});

await test('1ª frase que não fica pronta em 20 s encerra a resposta', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ manual: true });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(OUTPUT_LIMITS.firstSentenceWaitMs - 1);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
  await w.clock.advance(2);
  assert.deepStrictEqual(reasons(job), ['synth-timeout']);
  assert.strictEqual(job.calls[0].signal.aborted, true);
  assert.strictEqual(w.clock.pending(), 0);
});

await test('Buffering preso por 8 s encerra só esta resposta (a fila segue)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 1 });
  const b = w.job({ userId: 'u2', count: 1 });
  const c = w.job({ userId: 'u3', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  w.mgr.enqueue('g1', c);
  await flush();
  const player = w.players[0];
  player.autoPlay = false; // a partir daqui os recursos novos ficam em Buffering
  player.end(); // `a` termina; `b` começa e fica em Buffering
  await flush();
  assert.deepStrictEqual(reasons(a), ['done']);
  assert.strictEqual(player.state.status, 'buffering');
  await w.clock.advance(OUTPUT_LIMITS.bufferingTimeoutMs - 1);
  assert.deepStrictEqual(reasons(b), []);
  await w.clock.advance(2);
  assert.deepStrictEqual(reasons(b), ['buffering-timeout']);
  assert.deepStrictEqual(reasons(c), [], 'a fila NÃO foi limpa: c é a próxima');
  assert.deepStrictEqual(w.playedIds(), [a.id(0), b.id(0), c.id(0)]);
  w.mgr.disposeAll();
});

await test('Buffering que vira Playing a tempo cancela o timeout', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  const player = w.players[0];
  player.end(); // termina o 1º; cria um job novo em Buffering
  await flush();
  player.autoPlay = false;
  const next = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', next);
  await flush();
  assert.strictEqual(player.state.status, 'buffering');
  await w.clock.advance(3000);
  player.becomePlaying();
  await w.clock.advance(20_000);
  assert.deepStrictEqual(reasons(next), [], 'não foi encerrada: o timeout foi cancelado');
});

// ── Conexão ───────────────────────────────────────────────────────────

await test('Destroyed faz dispose: limpa a fila, para o player e solta os ouvintes', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 2 });
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  await flush();
  assert.strictEqual(conn.listenerCount('destroyed'), 1);
  conn.setStatus('destroyed');
  await flush();
  assert.deepStrictEqual(reasons(a), ['connection-destroyed']);
  assert.deepStrictEqual(reasons(b), ['connection-destroyed']);
  assert.strictEqual(w.players[0].stops, 1);
  assert.strictEqual(w.mgr.getStatus().count, 0);
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.strictEqual(conn.listenerCount('destroyed'), 0);
  assert.strictEqual(conn.listenerCount('disconnected'), 0);
  assert.strictEqual(w.clock.pending(), 0);
});

await test('Disconnected sem reconexão em 5 s faz dispose', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  conn.setStatus('disconnected');
  await w.clock.advance(OUTPUT_LIMITS.reconnectGraceMs - 1);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true, 'ainda na janela de reconexão');
  assert.deepStrictEqual(reasons(job), []);
  await w.clock.advance(2);
  assert.deepStrictEqual(reasons(job), ['connection-lost']);
  assert.strictEqual(w.mgr.getStatus().count, 0);
});

await test('reconexão: Disconnected seguido de Signalling NÃO faz dispose', async () => {
  const w = makeWorld({ config: { maxSeconds: 600 } });
  const conn = w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  conn.setStatus('disconnected');
  await w.clock.advance(1000);
  conn.setStatus('signalling');
  await flush();
  await w.clock.advance(20_000);
  assert.deepStrictEqual(reasons(job), [], 'a fala segue de pé');
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
  assert.strictEqual(w.mgr.getStatus().count, 1);

  // Reconectou; um novo ciclo de queda também é tratado (o estado "reconectando" foi liberado).
  conn.setStatus('ready');
  conn.setStatus('disconnected');
  await w.clock.advance(OUTPUT_LIMITS.reconnectGraceMs + 10);
  assert.deepStrictEqual(reasons(job), ['connection-lost']);
});

await test('Disconnected seguido de Connecting também conta como reconexão', async () => {
  const w = makeWorld({ config: { maxSeconds: 600 } });
  const conn = w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  conn.setStatus('disconnected');
  conn.setStatus('connecting');
  await flush();
  await w.clock.advance(10_000);
  assert.deepStrictEqual(reasons(job), []);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
});

await test('troca de conexão (rádio recriou): reassina na nova e solta a antiga', async () => {
  const w = makeWorld();
  const connA = w.addConn('g1');
  const job = w.job({ count: 3 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.strictEqual(connA.subscribed.length, 1);
  assert.strictEqual(connA.listenerCount('destroyed'), 1);

  const connB = new FakeConn();
  w.conns.set('g1', connB); // o getConnection passa a devolver outra
  await w.endSentence();
  assert.strictEqual(connB.subscribed.length, 1, 'reassinou na conexão nova');
  assert.strictEqual(connB.subscribed[0], w.players[0], 'o mesmo player de TTS');
  assert.strictEqual(connA.unsubscribed.length, 1, 'soltou a assinatura da antiga');
  assert.strictEqual(connA.listenerCount('destroyed'), 0);
  assert.strictEqual(connB.listenerCount('destroyed'), 1);
  assert.deepStrictEqual(w.playedIds(), [job.id(0), job.id(1)]);

  // A antiga morrer agora não derruba a fala da nova.
  connA.setStatus('destroyed');
  await flush();
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
});

await test('outro player (rádio) roubou a assinatura: reassina na próxima frase', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.strictEqual(conn.subscribed.length, 1);
  conn.state.subscription = { player: { fake: 'radio' }, unsubscribe() {} };
  await w.endSentence();
  assert.strictEqual(conn.subscribed.length, 2, 'reassinou');
  assert.strictEqual(conn.state.subscription.player, w.players[0]);
});

await test('conexão ausente ou ainda não Ready: não fala e encerra com a razão certa', async () => {
  const w = makeWorld();
  const none = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', none); // sem conexão registrada
  await flush();
  assert.deepStrictEqual(reasons(none), ['no-connection']);

  const conn = w.addConn('g1');
  conn.state.status = 'signalling';
  const notReady = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', notReady);
  await flush();
  assert.deepStrictEqual(reasons(notReady), ['not-ready']);
  assert.strictEqual(conn.subscribed.length, 0);
  assert.strictEqual(w.resources.length, 0);
});

await test('getConnection que lança é tratado como sem conexão', async () => {
  const w = makeWorld({ deps: { getConnection: () => { throw new Error('x'); } } });
  const job = w.job({ count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.deepStrictEqual(reasons(job), ['no-connection']);
});

await test('rádio ativo: não assina, não cria player e não fala', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  w.radio.add('g1');
  const job = w.job({ count: 2 });
  const res = w.mgr.enqueue('g1', job);
  await flush();
  assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'radio-active' });
  assert.strictEqual(w.players.length, 0);
  assert.strictEqual(conn.subscribed.length, 0);
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.strictEqual(job.calls.length, 0, 'nem sintetiza');
});

await test('rádio começa entre as frases: encerra sem assinar de novo', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  const job = w.job({ count: 3 });
  w.mgr.enqueue('g1', job);
  await flush();
  w.radio.add('g1');
  await w.endSentence();
  assert.deepStrictEqual(reasons(job), ['radio-active']);
  assert.strictEqual(job.finishes[0].sentencesPlayed, 1);
  assert.strictEqual(conn.subscribed.length, 1, 'não assinou de novo');
  assert.strictEqual(w.resources.length, 1);
});

await test('player AutoPaused com rádio ativo interrompe a fala', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  w.players[0].emit('autopaused'); // rádio ainda não ativo: nada acontece
  assert.deepStrictEqual(reasons(job), []);
  w.radio.add('g1');
  w.players[0].emit('autopaused');
  assert.deepStrictEqual(reasons(job), ['radio']);
});

await test('player e conexão têm ouvinte de erro; o erro é logado só pelo código', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  w.mgr.enqueue('g1', w.job({ count: 1 }));
  await flush();
  const player = w.players[0];
  assert.ok(player.listenerCount('error') >= 1);
  assert.ok(conn.listenerCount('error') >= 1);
  assert.doesNotThrow(() => player.emit('error', Object.assign(new Error('FALA-VAZADA'), { code: 'EPIPE' })));
  assert.doesNotThrow(() => conn.emit('error', Object.assign(new Error('FALA-VAZADA'), { name: 'NetworkingError' })));
  assert.ok(w.logText().includes('EPIPE'));
  assert.ok(w.logText().includes('NetworkingError'));
  assert.ok(!w.logText().includes('VAZADA'));
});

// ── DAVE (voicePrivacyCode) ───────────────────────────────────────────

await test('DAVE: sem sessão DAVE a espera é pulada e o motivo é registrado uma vez', async () => {
  const w = makeWorld();
  w.addConn('g1', { dave: null });
  w.addConn('g2', { dave: null });
  w.mgr.enqueue('g1', w.job({ count: 1 }));
  await flush();
  assert.strictEqual(w.resources.length, 1, 'tocou sem esperar nada');
  assert.strictEqual(w.clock.pending(), 1, 'só o watchdog está armado (nenhuma espera)');
  w.mgr.enqueue('g2', w.job({ count: 1 }));
  await flush();
  assert.strictEqual(w.resources.length, 2);
  const skips = w.logs.filter(([, m]) => m.includes('DAVE') && m.includes('dispensada'));
  assert.strictEqual(skips.length, 1, 'o motivo foi registrado uma vez só');
});

await test('DAVE: protocolo 0, API ausente e palco também pulam a espera', async () => {
  const w = makeWorld({ deps: { isStageChannel: (guildId) => guildId === 'palco' } });
  w.addConn('v0', { dave: { protocolVersion: 0 } });
  w.addConn('antiga', { dave: { protocolVersion: 1 }, withPrivacyApi: false });
  w.addConn('palco', { dave: { protocolVersion: 1 } });
  for (const guildId of ['v0', 'antiga', 'palco']) {
    w.mgr.enqueue(guildId, w.job({ count: 1 }));
    await flush();
  }
  assert.strictEqual(w.resources.length, 3, 'as três falaram na hora');
  const text = w.logText();
  assert.ok(text.includes('protocolo DAVE 0'));
  assert.ok(text.includes('não expõe voicePrivacyCode'));
  assert.ok(text.includes('palco'));
});

await test('DAVE ativo: espera o código (polling de 100 ms) e só na 1ª fala da conexão', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1', { dave: { protocolVersion: 1 } });
  const a = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', a);
  await flush();
  assert.strictEqual(w.resources.length, 0, 'aguardando o código de privacidade');
  assert.strictEqual(conn.subscribed.length, 1, 'já assinou; só não tocou ainda');
  await w.clock.advance(400);
  assert.strictEqual(w.resources.length, 0);
  conn.code = '12345 67890';
  await w.clock.advance(100);
  assert.strictEqual(w.resources.length, 1, 'tocou assim que o código apareceu');
  await w.endSentence();

  // Segunda fala na mesma conexão: o código já existe e a espera não se repete.
  const b = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', b);
  await flush();
  assert.strictEqual(w.resources.length, 2);
  assert.ok(!w.logText().includes('não apareceu'), 'não houve timeout');
});

await test('DAVE ativo sem código: fala depois de 3 s mesmo assim e avisa uma vez', async () => {
  const w = makeWorld();
  w.addConn('g1', { dave: { protocolVersion: 1 } });
  w.mgr.enqueue('g1', w.job({ userId: 'u1', count: 1 }));
  await flush();
  await w.clock.advance(OUTPUT_LIMITS.privacyWaitMs - 100);
  assert.strictEqual(w.resources.length, 0);
  await w.clock.advance(200);
  assert.strictEqual(w.resources.length, 1);
  assert.strictEqual(w.logs.filter(([level, m]) => level === 'warn' && m.includes('não apareceu')).length, 1);
});

await test('interrupção durante a espera do DAVE: nada toca e nenhum timer sobra', async () => {
  const w = makeWorld();
  w.addConn('g1', { dave: { protocolVersion: 1 } });
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(300);
  w.mgr.interrupt('g1', 'user-stop');
  await w.clock.advance(5000);
  assert.deepStrictEqual(reasons(job), ['user-stop']);
  assert.strictEqual(w.resources.length, 0);
  assert.strictEqual(w.clock.pending(), 0);
});

// ── Janela de eco ─────────────────────────────────────────────────────

await test('janela de eco: antes, durante e depois (+ margem) da fala', async () => {
  const w = makeWorld(); // margem 1500 ms
  w.addConn('g1');
  const job = w.job({ count: 1 });
  assert.strictEqual(w.mgr.overlapsSpeech('g1', 0, 1e12), false, 'sem fala nenhuma');
  w.mgr.enqueue('g1', job);
  await flush();
  const t0 = w.clock.now(); // a fala começou agora
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 - 3000, t0 - 2000), false, 'tudo antes');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 - 100, t0 - 1), false, 'termina um instante antes');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 - 100, t0 + 50), true, 'cruza o início');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 + 10, t0 + 20), true, 'durante');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 + 5000, t0 + 9000), true, 'durante (ela ainda fala)');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 + 20, t0 + 10), true, 'extremos trocados');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', NaN, 5), false);
  assert.strictEqual(w.mgr.overlapsSpeech('g2', t0, t0 + 10), false, 'outro servidor');

  await w.endSentence();
  const t1 = w.clock.now(); // terminou
  assert.strictEqual(job.finishes[0].reason, 'done');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t1 + 100, t1 + 200), true, 'dentro da margem');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t1 + 1500, t1 + 1600), true, 'limite da margem (inclusivo)');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t1 + 1501, t1 + 1600), false, 'depois da margem');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t1 + 5000, t1 + 6000), false);
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t0 + 10, t0 + 20), true, 'o passado dela continua marcado');
});

await test('janela de eco: interrupção também fecha a janela (com a margem)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.enqueue('g1', w.job({ count: 2 }));
  await flush();
  await w.clock.advance(400);
  w.mgr.interrupt('g1', 'barge-in');
  const t = w.clock.now();
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t + 1000, t + 1100), true);
  assert.strictEqual(w.mgr.overlapsSpeech('g1', t + 1600, t + 1700), false);
});

await test('janela de eco: respostas seguidas geram janelas separadas (o intervalo entre elas não conta)', async () => {
  const w = makeWorld({ config: { echoGuardMs: 100 } });
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', a);
  await flush();
  const a0 = w.clock.now();
  await w.endSentence();
  const a1 = w.clock.now();
  await w.clock.advance(10_000); // silêncio longo
  const b = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', b);
  await flush();
  const b0 = w.clock.now();
  assert.strictEqual(w.mgr.overlapsSpeech('g1', a0, a1), true);
  assert.strictEqual(w.mgr.overlapsSpeech('g1', a1 + 1000, b0 - 1000), false, 'o silêncio entre as duas');
  assert.strictEqual(w.mgr.overlapsSpeech('g1', b0, b0 + 1), true);
});

// ── Barge-in ──────────────────────────────────────────────────────────

/** Servidor com uma fala longa do usuário u1 já no ar. */
async function speakingWorld(config) {
  const w = makeWorld({ config: { maxSeconds: 600, ...config } });
  w.addConn('g1');
  const job = w.job({ userId: 'u1', count: 3 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.strictEqual(w.resources.length, 1);
  return { w, job };
}

await test('barge-in: 800 ms contínuos de fala do dono do pedido interrompem', async () => {
  const { w, job } = await speakingWorld();
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(799);
  assert.deepStrictEqual(reasons(job), []);
  await w.clock.advance(1);
  assert.deepStrictEqual(reasons(job), ['barge-in']);
  assert.strictEqual(w.mgr.isSpeaking('g1'), false);
  assert.strictEqual(w.clock.pending(), 0);
});

await test('barge-in: soma trechos curtos dentro da janela de 2 s', async () => {
  const { w, job } = await speakingWorld();
  w.mgr.noteHumanSpeaking('g1', 'u1', true); // 500 ms falando...
  await w.clock.advance(500);
  w.mgr.noteHumanSpeaking('g1', 'u1', false);
  await w.clock.advance(100); // ...pausa curta...
  w.mgr.noteHumanSpeaking('g1', 'u1', true); // ...e mais 300 ms = 800
  await w.clock.advance(299);
  assert.deepStrictEqual(reasons(job), []);
  await w.clock.advance(1);
  assert.deepStrictEqual(reasons(job), ['barge-in']);
});

await test('barge-in: 300 ms de fala não interrompem', async () => {
  const { w, job } = await speakingWorld();
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(300);
  w.mgr.noteHumanSpeaking('g1', 'u1', false);
  await w.clock.advance(10_000);
  assert.deepStrictEqual(reasons(job), []);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
});

await test('barge-in: trechos espalhados fora da janela de 2 s não somam', async () => {
  const { w, job } = await speakingWorld();
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(400);
  w.mgr.noteHumanSpeaking('g1', 'u1', false);
  await w.clock.advance(1600); // o primeiro trecho sai da janela
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(400);
  w.mgr.noteHumanSpeaking('g1', 'u1', false);
  await w.clock.advance(5000);
  assert.deepStrictEqual(reasons(job), []);
});

await test('barge-in: outro usuário e bot não interrompem (só o dono do pedido)', async () => {
  const { w, job } = await speakingWorld();
  w.mgr.noteHumanSpeaking('g1', 'u2', true);
  w.mgr.noteHumanSpeaking('g1', 'bot-1', true);
  await w.clock.advance(10_000);
  w.mgr.noteHumanSpeaking('g1', 'u2', false);
  w.mgr.noteHumanSpeaking('g1', 'bot-1', false);
  await w.clock.advance(1000);
  assert.deepStrictEqual(reasons(job), []);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
});

await test('barge-in desligado por configuração (bargeIn=false) nunca interrompe', async () => {
  const { w, job } = await speakingWorld({ bargeIn: false });
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(10_000);
  w.mgr.noteHumanSpeaking('g1', 'u1', false);
  await w.clock.advance(1000);
  assert.deepStrictEqual(reasons(job), []);
});

await test('barge-in respeita bargeInMs configurado', async () => {
  const { w, job } = await speakingWorld({ bargeInMs: 300 });
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(299);
  assert.deepStrictEqual(reasons(job), []);
  await w.clock.advance(1);
  assert.deepStrictEqual(reasons(job), ['barge-in']);
});

await test('noteHumanSpeaking é idempotente (repetir "começou"/"parou" não acumula a mais)', async () => {
  const { w, job } = await speakingWorld();
  // "começou" repetido não reinicia nem soma em dobro
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(300);
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(300);
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(199);
  assert.deepStrictEqual(reasons(job), [], '799 ms reais: ainda não');
  await w.clock.advance(1);
  assert.deepStrictEqual(reasons(job), ['barge-in'], '800 ms reais: dispara uma única vez');
  assert.strictEqual(job.finishes.length, 1);

  // "parou" repetido (ou sem "começou") não vira trecho extra
  const second = await speakingWorld();
  const s = second.w;
  s.mgr.noteHumanSpeaking('g1', 'u1', false); // sem ter começado
  s.mgr.noteHumanSpeaking('g1', 'u1', true);
  await s.clock.advance(300);
  s.mgr.noteHumanSpeaking('g1', 'u1', false);
  s.mgr.noteHumanSpeaking('g1', 'u1', false);
  s.mgr.noteHumanSpeaking('g1', 'u1', false);
  await s.clock.advance(100);
  s.mgr.noteHumanSpeaking('g1', 'u1', true);
  await s.clock.advance(400); // 300 + 400 = 700: se o "parou" contasse 3x, já teria disparado
  assert.deepStrictEqual(reasons(second.job), []);
  await s.clock.advance(100);
  assert.deepStrictEqual(reasons(second.job), ['barge-in']);
});

await test('barge-in: quem já falava quando a Yui começou conta a partir do 1º som', async () => {
  const w = makeWorld({ config: { maxSeconds: 600 } });
  w.addConn('g1');
  const job = w.job({ userId: 'u1', count: 1, manual: true });
  w.mgr.enqueue('g1', job);
  await flush();
  w.mgr.noteHumanSpeaking('g1', 'u1', true); // falando enquanto a resposta é preparada
  await w.clock.advance(2000);
  assert.deepStrictEqual(reasons(job), [], 'a Yui nem falou ainda: nada a interromper');
  job.resolve(0);
  await flush();
  // Com gente falando, a Yui espera até 4 s (T1 1.4) antes do 1º som; o relógio da fala só conta depois dele.
  await w.clock.advance(3900);
  assert.strictEqual(w.players[0]?.played.length ?? 0, 0, 'ainda esperando a pessoa terminar');
  assert.deepStrictEqual(reasons(job), [], 'a espera não conta como fala por cima');
  await w.clock.advance(100); // acabou a espera: 1º som agora
  assert.strictEqual(w.players[0].played.length, 1);
  await w.clock.advance(799);
  assert.deepStrictEqual(reasons(job), []);
  await w.clock.advance(1);
  assert.deepStrictEqual(reasons(job), ['barge-in'], 'contou só os 800 ms depois do 1º som');
});

await test('barge-in: a contagem não passa para a resposta seguinte', async () => {
  const w = makeWorld({ config: { maxSeconds: 600 } });
  w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 1 });
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  await flush();
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(500);
  w.mgr.noteHumanSpeaking('g1', 'u1', false);
  w.players[0].end(); // a termina, b começa
  await flush();
  // u1 (dono de a) fala por cima de b: não é o dono de b
  w.mgr.noteHumanSpeaking('g1', 'u1', true);
  await w.clock.advance(5000);
  assert.deepStrictEqual(reasons(a), ['done']);
  assert.deepStrictEqual(reasons(b), []);
  assert.strictEqual(w.mgr.isSpeaking('g1'), true);
});

await test('barge-in: "parou" que nunca chegou não vale para sempre', async () => {
  const w = makeWorld({ config: { maxSeconds: 600 } });
  w.addConn('g1');
  w.mgr.enqueue('g1', w.job({ userId: 'u1', count: 1 }));
  await flush();
  // u1 fica marcado como falando por mais que o teto, antes de uma fala nova começar
  w.players[0].end();
  await flush();
  w.mgr.noteHumanSpeaking('g1', 'u1', true); // sem fala em andamento: só marca
  await w.clock.advance(OUTPUT_LIMITS.maxOpenSpeechMs + 1000);
  const job = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(3000);
  assert.deepStrictEqual(reasons(job), [], 'o "começou" antigo foi descartado');
});

// ── Status, descarte, timers ──────────────────────────────────────────

await test('getStatus não traz texto e mostra o estado por servidor', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.enqueue('g1', w.job({ userId: 'u1', count: 2 }));
  w.mgr.enqueue('g1', w.job({ userId: 'u2', count: 2 }));
  await flush();
  const status = w.mgr.getStatus();
  assert.strictEqual(status.count, 1);
  assert.deepStrictEqual(Object.keys(status.guilds[0]).sort(), [
    'audible', 'connected', 'generation', 'guildId', 'hasPlayer', 'queued', 'speaking',
  ]);
  assert.strictEqual(status.guilds[0].speaking, true);
  assert.strictEqual(status.guilds[0].audible, true);
  assert.strictEqual(status.guilds[0].queued, 1);
  assert.strictEqual(status.guilds[0].connected, true);
});

await test('dispose(guildId) descarta tudo; disposeAll descarta todos os servidores', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.addConn('g2');
  const a = w.job({ userId: 'u1', count: 2 });
  const b = w.job({ userId: 'u1', count: 2 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g2', b);
  await flush();
  assert.strictEqual(w.mgr.dispose('g1'), true);
  assert.deepStrictEqual(reasons(a), ['disposed']);
  assert.strictEqual(w.mgr.dispose('g1'), false, 'idempotente');
  assert.strictEqual(w.mgr.getStatus().count, 1);
  assert.strictEqual(w.mgr.disposeAll(), 1);
  assert.deepStrictEqual(reasons(b), ['shutdown']);
  assert.strictEqual(w.mgr.getStatus().count, 0);
  assert.strictEqual(w.clock.pending(), 0, 'nenhum timer pendente depois de descartar tudo');
  await w.clock.advance(60_000);
  assert.strictEqual(w.resources.length, 2, 'nada tocou depois do descarte');

  // Servidor descartado volta a funcionar com um player novo (ex.: Yui entrou de novo na call).
  const c = w.job({ userId: 'u1', count: 1 });
  assert.strictEqual(w.mgr.enqueue('g1', c).ok, true);
  await flush();
  assert.strictEqual(w.players.length, 3);
  assert.strictEqual(w.resources.length, 3);
});

await test('nenhum timer pendente depois de uma resposta completa, de interrupção e de falha', async () => {
  const w = makeWorld();
  w.addConn('g1', { dave: { protocolVersion: 1 } });
  w.conns.get('g1').code = 'ok';
  const done = w.job({ userId: 'u1', count: 2 });
  w.mgr.enqueue('g1', done);
  await flush();
  await w.endSentence();
  await w.endSentence();
  assert.deepStrictEqual(reasons(done), ['done']);
  assert.strictEqual(w.clock.pending(), 0, 'resposta completa');

  const cut = w.job({ userId: 'u1', count: 3, manual: true });
  w.mgr.enqueue('g1', cut);
  await flush();
  cut.resolve(0);
  await flush();
  w.mgr.interrupt('g1', 'barge-in');
  await flush();
  assert.strictEqual(w.clock.pending(), 0, 'interrompida');

  const bad = w.job({ userId: 'u1', count: 1, synth: () => Promise.reject(new Error('x')) });
  w.mgr.enqueue('g1', bad);
  await flush();
  assert.strictEqual(w.clock.pending(), 0, 'falha de síntese');
  assert.deepStrictEqual(escaped, []);
});

// ── Correções da revisão ──────────────────────────────────────────────

// Player sem assinatura: o Idle nunca chega, então sem tratamento a fila ficava presa até o watchdog (30 s).
await test('player AutoPaused SEM rádio e com a assinatura tomada por outro player: encerra a resposta já e a fila segue', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  const a = w.job({ userId: 'u1', count: 2 });
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', a);
  w.mgr.enqueue('g1', b);
  await flush();
  assert.strictEqual(w.resources.length, 1);
  conn.state.subscription = { player: { fake: 'outro' }, unsubscribe() {} }; // rádio ainda subindo / entrada repetida na call
  w.players[0].emit('autopaused');
  await flush();
  assert.deepStrictEqual(reasons(a), ['unsubscribed'], 'sem esperar o watchdog');
  assert.strictEqual(a.finishes[0].sentencesTotal, 2);
  assert.strictEqual(conn.subscribed.length, 2, 'a próxima da fila reassinou');
  assert.strictEqual(w.resources.length, 2, 'e já está falando');
  assert.deepStrictEqual(reasons(b), []);
});

await test('player AutoPaused sem rádio e sem NENHUMA assinatura: encerra; com a assinatura ainda nossa não faz nada', async () => {
  const w = makeWorld();
  const conn = w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  w.players[0].emit('autopaused'); // a assinatura ainda é do nosso player: nada a fazer
  assert.deepStrictEqual(reasons(job), []);
  conn.state.subscription = undefined;
  w.players[0].emit('autopaused');
  assert.deepStrictEqual(reasons(job), ['unsubscribed']);
  w.players[0].emit('autopaused'); // sem resposta em andamento: ignorado
  assert.strictEqual(job.finishes.length, 1);
});

async function worldWaitingDave() {
  const w = makeWorld();
  const conn = w.addConn('g1', { dave: { protocolVersion: 1 } });
  const job = w.job({ count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(300); // no meio da espera do código de privacidade (DAVE)
  assert.strictEqual(w.resources.length, 0);
  return { w, conn, job };
}

await test('DAVE: o rádio liga DURANTE a espera do código => a frase não sai por cima da música', async () => {
  const { w, conn, job } = await worldWaitingDave();
  w.radio.add('g1');
  conn.code = '12345 67890';
  await w.clock.advance(200);
  assert.deepStrictEqual(reasons(job), ['radio-active']);
  assert.strictEqual(w.players[0].played.length, 0, 'nenhum play');
  assert.strictEqual(w.resources.length, 0, 'nem recurso');
  assert.ok(w.readables.every((r) => r.destroyed), 'o stream preparado foi solto');
});

await test('DAVE: a conexão cai DURANTE a espera do código => não toca', async () => {
  const { w, conn, job } = await worldWaitingDave();
  conn.state.status = 'disconnected';
  conn.code = '12345 67890';
  await w.clock.advance(200);
  assert.deepStrictEqual(reasons(job), ['not-ready']);
  assert.strictEqual(w.players[0].played.length, 0);
});

await test('DAVE: a conexão é TROCADA durante a espera do código => não toca na antiga', async () => {
  const { w, conn, job } = await worldWaitingDave();
  w.addConn('g1'); // o rádio recriou a conexão
  conn.code = '12345 67890';
  await w.clock.advance(200);
  assert.deepStrictEqual(reasons(job), ['no-connection']);
  assert.strictEqual(w.players[0].played.length, 0);
});

await test('DAVE: outro player toma a assinatura DURANTE a espera do código => não toca no vazio', async () => {
  const { w, conn, job } = await worldWaitingDave();
  conn.state.subscription = { player: { fake: 'radio' }, unsubscribe() {} };
  conn.code = '12345 67890';
  await w.clock.advance(200);
  assert.deepStrictEqual(reasons(job), ['unsubscribed']);
  assert.strictEqual(w.players[0].played.length, 0);
});

await test('DAVE: o código só é esperado na 1ª fala da conexão (a 2ª fala não espera, mesmo sem código)', async () => {
  const w = makeWorld();
  w.addConn('g1', { dave: { protocolVersion: 1 } }); // o código nunca aparece
  w.mgr.enqueue('g1', w.job({ userId: 'u1', count: 1 }));
  await flush();
  await w.clock.advance(OUTPUT_LIMITS.privacyWaitMs + 100);
  assert.strictEqual(w.resources.length, 1);
  await w.endSentence();
  const b = w.job({ userId: 'u2', count: 1 });
  w.mgr.enqueue('g1', b);
  await flush();
  assert.strictEqual(w.resources.length, 2, 'falou na hora, sem esperar 3 s de novo');
  assert.ok(w.logs.filter(([, m]) => m.includes('não apareceu')).length <= 1);
});

// ── Não falar por cima de gente (T1 1.4) ──────────────────────────────

await test('alguém falando quando a resposta fica pronta: espera e fala logo que a pessoa para', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.noteHumanSpeaking('g1', 'u9', true); // já falava ANTES de existir fila neste servidor
  const job = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  assert.strictEqual(w.resources.length, 0, 'espera');
  assert.strictEqual(job.calls.length, 1, 'mas a síntese já foi pedida (não perde tempo)');
  await w.clock.advance(1000);
  assert.strictEqual(w.resources.length, 0);
  w.mgr.noteHumanSpeaking('g1', 'u9', false);
  await w.clock.advance(100);
  assert.strictEqual(w.resources.length, 1, 'falou assim que a pessoa parou');
  assert.strictEqual(w.clock.pending() >= 0, true);
});

await test('alguém falando sem parar: espera no máximo 4 s e fala mesmo assim', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.enqueue('g1', w.job({ userId: 'u1', count: 1 })); // cria o servidor
  await flush();
  await w.endSentence();
  w.mgr.noteHumanSpeaking('g1', 'u9', true); // agora com o servidor já criado
  const job = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(OUTPUT_LIMITS.quietWaitMs - 100);
  assert.strictEqual(w.resources.length, 1, 'ainda esperando (só o da 1ª resposta)');
  await w.clock.advance(200);
  assert.strictEqual(w.resources.length, 2, 'passou de 4 s: fala');
  assert.deepStrictEqual(reasons(job), []);
});

await test('a espera por silêncio vale só para a 1ª frase da resposta; as seguintes não esperam', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.noteHumanSpeaking('g1', 'u9', true);
  const job = w.job({ userId: 'u1', count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(200);
  w.mgr.noteHumanSpeaking('g1', 'u9', false);
  await w.clock.advance(100);
  assert.strictEqual(w.resources.length, 1);
  w.mgr.noteHumanSpeaking('g1', 'u8', true); // outra pessoa começa a falar no meio da resposta
  await w.endSentence();
  assert.strictEqual(w.resources.length, 2, 'a 2ª frase tocou na hora');
});

await test('interromper durante a espera por silêncio: nada toca e nenhum timer sobra', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.noteHumanSpeaking('g1', 'u9', true);
  const job = w.job({ userId: 'u1', count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(500);
  w.mgr.interrupt('g1', 'user-stop');
  await w.clock.advance(6000);
  assert.deepStrictEqual(reasons(job), ['user-stop']);
  assert.strictEqual(w.resources.length, 0);
  assert.strictEqual(w.clock.pending(), 0);
});

await test('"começou a falar" que nunca teve o "parou" (mais de 120 s) não faz a Yui esperar; "parou" antes da fila limpa tudo', async () => {
  const w = makeWorld();
  w.addConn('g1');
  w.mgr.noteHumanSpeaking('g1', 'u9', true);
  w.mgr.noteHumanSpeaking('g1', 'u7', true);
  w.mgr.noteHumanSpeaking('g1', 'u7', false); // este parou antes de existir fila
  await w.clock.advance(OUTPUT_LIMITS.maxOpenSpeechMs + 1000); // u9 ficou "falando" para sempre
  w.mgr.enqueue('g1', w.job({ userId: 'u1', count: 1 }));
  await flush();
  assert.strictEqual(w.resources.length, 1, 'não esperou por um "parou" perdido');

  const w2 = makeWorld();
  w2.addConn('g1');
  w2.mgr.noteHumanSpeaking('g1', 'u7', true);
  w2.mgr.noteHumanSpeaking('g1', 'u7', false);
  assert.strictEqual(w2.mgr.getStatus().count, 0, 'nenhum servidor foi criado só por eventos de fala');
  w2.mgr.enqueue('g1', w2.job({ userId: 'u1', count: 1 }));
  await flush();
  assert.strictEqual(w2.resources.length, 1, 'quem já parou não faz esperar');
});

await test('barge-in cego antes de o servidor existir: o dono que já falava ANTES da fila interrompe depois do 1º som', async () => {
  const w = makeWorld({ config: { maxSeconds: 600 } });
  w.addConn('g1');
  w.mgr.noteHumanSpeaking('g1', 'u1', true); // sem GuildSpeaker ainda: o evento tinha sido descartado
  const job = w.job({ userId: 'u1', count: 1 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(OUTPUT_LIMITS.quietWaitMs); // espera os 4 s e fala por cima do dono
  assert.strictEqual(w.resources.length, 1);
  await w.clock.advance(799);
  assert.deepStrictEqual(reasons(job), []);
  await w.clock.advance(1);
  assert.deepStrictEqual(reasons(job), ['barge-in']);
});

await test('eventos de fala de servidores sem fila têm teto (nada cresce sem limite) e não criam servidor', async () => {
  const w = makeWorld();
  for (let g = 0; g < 500; g += 1) w.mgr.noteHumanSpeaking(`g${g}`, 'u1', true);
  for (let u = 0; u < 200; u += 1) w.mgr.noteHumanSpeaking('gx', `u${u}`, true);
  w.mgr.noteHumanSpeaking('', 'u1', true);
  w.mgr.noteHumanSpeaking('g1', '', true);
  assert.strictEqual(w.mgr.getStatus().count, 0);
  assert.strictEqual(w.mgr.disposeAll('fim'), 0);
});

// ── Limites e invariantes que faltavam ────────────────────────────────

await test('validade: 30 s exatos ainda valem; 30,001 s não (limite do `>`)', async () => {
  for (const [idade, esperado] of [[30_000, []], [30_001, ['stale']]]) {
    const w = makeWorld();
    w.addConn('g1');
    const job = w.job({ requestedAt: w.clock.now() - idade, count: 1 });
    w.mgr.enqueue('g1', job);
    await flush();
    assert.deepStrictEqual(reasons(job), esperado, `${idade} ms`);
  }
});

await test('PCM de 100 bytes (menos que um quadro de 20 ms) é falha de síntese, como vazio', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const curto = w.job({ synth: () => Promise.resolve(Buffer.alloc(100)) });
  const quase = w.job({ userId: 'u2', synth: () => Promise.resolve(Buffer.alloc(FRAME - 1)) });
  w.mgr.enqueue('g1', curto);
  w.mgr.enqueue('g1', quase);
  await flush();
  assert.deepStrictEqual(reasons(curto), ['synth-failed']);
  assert.deepStrictEqual(reasons(quase), ['synth-failed']);
  assert.strictEqual(w.resources.length, 0);
});

await test('interromper no meio da 1ª frase conta só o tempo que foi ao ar (spokenMs parcial)', async () => {
  const w = makeWorld();
  w.addConn('g1');
  const job = w.job({ count: 2 });
  w.mgr.enqueue('g1', job);
  await flush();
  await w.clock.advance(100); // a frase dura 200 ms
  w.mgr.interrupt('g1', 'user-stop');
  const info = job.finishes[0];
  assert.strictEqual(info.spokenMs, 100);
  assert.strictEqual(info.sentencesPlayed, 0);
});

// ── Aquecimento do codificador Opus ───────────────────────────────────

function warmupWorld(extra = {}) {
  const created = [];
  const w = makeWorld({
    deps: {
      createResource: (readable, options) => {
        if (extra.throws) throw Object.assign(new Error('sem opus'), { code: 'NO_OPUS' });
        const playStream = new EventEmitter();
        const on = playStream.on.bind(playStream);
        playStream.on = (event, fn) => {
          on(event, fn);
          if (event === 'data') setImmediate(() => playStream.emit('end'));
          return playStream;
        };
        playStream.destroy = () => { playStream.destroyed = true; };
        const resource = extra.noStream ? { readable, options } : { readable, options, playStream };
        created.push(resource);
        return resource;
      },
    },
  });
  w.created = created;
  return w;
}

await test('manager.warmup(): codifica um trecho de silêncio uma vez, solta tudo e não cria player nem assina', async () => {
  const w = warmupWorld();
  w.addConn('g1');
  assert.strictEqual(await w.mgr.warmup(), true);
  assert.strictEqual(await w.mgr.warmup(), true, 'segunda chamada reaproveita');
  assert.strictEqual(w.created.length, 1);
  assert.strictEqual(w.created[0].options.inputType, 'raw');
  assert.ok(w.readables[0].pcm.length > 0 && w.readables[0].pcm.length % FRAME === 0, 'quadros inteiros de 20 ms');
  assert.ok(w.readables[0].pcm.every((b) => b === 0), 'silêncio');
  assert.strictEqual(w.created[0].playStream.destroyed, true);
  assert.strictEqual(w.readables[0].destroyed, true);
  assert.strictEqual(w.players.length, 0);
  assert.strictEqual(w.conns.get('g1').subscribed.length, 0);
  assert.strictEqual(w.clock.pending(), 0, 'o prazo de segurança foi cancelado');
});

await test('manager.warmup(): sem Opus, sem stream ou com erro devolve false sem lançar, e tenta de novo depois', async () => {
  const sem = warmupWorld({ throws: true });
  assert.strictEqual(await sem.mgr.warmup(), false);
  const semStream = warmupWorld({ noStream: true });
  assert.strictEqual(await semStream.mgr.warmup(), false);
  assert.strictEqual(await semStream.mgr.warmup(), false);
  assert.strictEqual(semStream.created.length, 2, 'falhou: a próxima chamada tenta de novo');
  assert.strictEqual(semStream.clock.pending(), 0);
});

await test('os padrões usam o @discordjs/voice real e o import não tem efeito colateral', async () => {
  const require = createRequire(import.meta.url);
  let voice;
  try {
    voice = require('@discordjs/voice');
  } catch {
    skipped += 1;
    console.log('  [SKIP] @discordjs/voice indisponível');
    return;
  }
  // Os valores que os dublês usam são exatamente os da biblioteca.
  for (const group of ['AudioPlayerStatus', 'VoiceConnectionStatus', 'StreamType', 'NoSubscriberBehavior']) {
    for (const [key, value] of Object.entries(LIB[group])) {
      assert.strictEqual(voice[group][key], value, `${group}.${key}`);
    }
  }
  // O módulo lê DAVE por estas formas: a propriedade (getter) e a sessão com protocolVersion.
  assert.ok('voicePrivacyCode' in voice.VoiceConnection.prototype, 'getter voicePrivacyCode na conexão real');
  assert.strictEqual(new voice.DAVESession(0, '1', '2', {}).protocolVersion, 0);
  assert.strictEqual(new voice.DAVESession(1, '1', '2', {}).protocolVersion, 1);
  const mgr = createSpeakerManager({}); // tudo padrão (logger preguiçoso, lib real)
  assert.deepStrictEqual(mgr.getStatus(), { guilds: [], count: 0 });
  assert.strictEqual(mgr.enqueue('g1', null).reason, 'invalid-job');
  assert.strictEqual(mgr.interrupt('g1'), false);
  assert.strictEqual(mgr.overlapsSpeech('g1', 0, 1), false);
  assert.strictEqual(mgr.isSpeaking('g1'), false);
});

await test('DAVE com a sessão REAL (DAVESession): protocolo 0 pula a espera, protocolo 1 espera o código', async () => {
  const require = createRequire(import.meta.url);
  let voice;
  try {
    voice = require('@discordjs/voice');
  } catch {
    skipped += 1;
    console.log('  [SKIP] @discordjs/voice indisponível');
    return;
  }
  const w = makeWorld();
  w.addConn('v0', { dave: new voice.DAVESession(0, '1', '2', {}) });
  const v1 = w.addConn('v1', { dave: new voice.DAVESession(1, '1', '2', {}) });
  w.mgr.enqueue('v0', w.job({ count: 1 }));
  await flush();
  assert.strictEqual(w.resources.length, 1, 'protocolo 0: fala na hora');
  w.mgr.enqueue('v1', w.job({ count: 1 }));
  await flush();
  assert.strictEqual(w.resources.length, 1, 'protocolo 1: espera o código de privacidade');
  v1.code = '11111 22222';
  await w.clock.advance(100);
  assert.strictEqual(w.resources.length, 2);
  w.mgr.disposeAll();
});

await test('contrato com o AudioPlayer REAL: Idle encadeia as frases até o fim (conexão falsa recebe pacotes)', async () => {
  const require = createRequire(import.meta.url);
  try {
    require('@discordjs/voice');
    require('opusscript');
  } catch {
    skipped += 1;
    console.log('  [SKIP] @discordjs/voice ou opusscript indisponível');
    return;
  }
  const realLogs = [];
  const conn = new EventEmitter();
  conn.state = { status: 'ready', subscription: undefined };
  conn.packets = 0;
  conn.subscribe = (player) => {
    const subscription = player.subscribe(conn);
    conn.state.subscription = subscription;
    return subscription;
  };
  conn.prepareAudioPacket = () => { conn.packets += 1; };
  conn.dispatchAudio = () => true;
  conn.setSpeaking = () => true;
  conn.onSubscriptionRemoved = () => {};

  const pcm = Buffer.alloc(FRAME * 15); // 300 ms de silêncio por frase
  const chunked = (buf) => Readable.from((function* parts() {
    for (let i = 0; i < buf.length; i += FRAME * 5) yield buf.subarray(i, i + FRAME * 5);
  })());

  // Lembra do estado do Idle real: oldState.resource deve ser o recurso que terminou.
  const idleResources = [];
  const mgr = createSpeakerManager({
    getConnection: () => conn,
    logger: {
      info: (m) => realLogs.push(m),
      warn: (m) => realLogs.push(m),
      error: (m) => realLogs.push(m),
      debug: NOOP,
    },
    config: { ...DEFAULT_CONFIG },
    readableFromPcm: chunked,
    createPlayer: (options) => {
      const player = require('@discordjs/voice').createAudioPlayer(options);
      player.on('idle', (oldState) => idleResources.push(oldState.resource));
      return player;
    },
  });

  const finish = await new Promise((resolve) => {
    const guard = setTimeout(() => resolve({ reason: 'tempo-esgotado' }), 15_000);
    mgr.enqueue('g1', {
      userId: 'u1',
      count: 2,
      requestedAt: Date.now(),
      synth: async () => pcm,
      onFinish: (info) => { clearTimeout(guard); resolve(info); },
    });
  });
  assert.strictEqual(finish.reason, 'done', realLogs.join('\n'));
  assert.strictEqual(finish.sentencesPlayed, 2);
  assert.ok(conn.packets >= 25, `pacotes recebidos: ${conn.packets}`);
  assert.ok(idleResources.length >= 2 && idleResources.every(Boolean), 'o Idle real traz oldState.resource');
  assert.strictEqual(new Set(idleResources).size, idleResources.length, 'um recurso por frase');
  mgr.disposeAll();
});

function NOOP() {}

// ── Resultado ─────────────────────────────────────────────────────────

if (escaped.length) {
  failed += 1;
  console.log(`  FALHA  exceções escaparam do módulo:\n      ${escaped.join('\n      ')}`);
}

console.log(`\n${passed} ok, ${failed} falha(s)${skipped ? `, ${skipped} pulado(s)` : ''}`);
if (failed > 0) process.exit(1);
// Sem process.exit(0) de propósito: se um timer ficar pendente, o alarme acima reprova.
