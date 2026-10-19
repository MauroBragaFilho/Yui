/**
 * Saída de áudio do TTS: um GuildSpeaker por servidor, dentro de um gerenciador.
 *
 * O que este módulo faz (e só ele):
 *  - dono ÚNICO do AudioPlayer de TTS de cada servidor e da assinatura dele na conexão de voz;
 *  - fila por servidor (máx. `queueMax` contando o que toca; 1 pendente por usuário; validade);
 *  - toca frase a frase: o AudioResource só nasce NA HORA de tocar (o prefetch guarda só PCM);
 *  - interrupção (barge-in, rádio, parada, watchdog), janela anti-eco e desconexão.
 *
 * Decisões que explicam o código:
 *  - Contador de GERAÇÃO: `player.stop(true)` leva a Idle, e esse Idle chega depois de a
 *    fila já ter sido limpa. Sem a geração, o Idle "velho" tocaria a próxima frase de uma
 *    resposta que já foi cancelada. Interromper incrementa a geração ANTES de parar o player.
 *  - A conexão vem de getConnection(guildId) a CADA frase: o Modo Rádio destrói e recria a
 *    conexão, então guardar a primeira levaria a falar numa conexão morta.
 *  - `Disconnected` NÃO é terminal (o Discord reconecta sozinho): só descartamos se não houver
 *    Signalling/Connecting em 5 s. `Destroyed` é terminal.
 *  - Nunca assinamos o player enquanto o rádio está ativo (assinar rouba o áudio da música).
 *    Depois do ÚLTIMO `await` antes do `play` (espera do DAVE, preparo do stream) tudo é conferido de
 *    novo (`stillCanPlay`): rádio, conexão atual em Ready e assinatura ainda nossa. E um player que
 *    perde a assinatura sem o rádio marcado (`AutoPaused`) encerra a resposta já, sem esperar o watchdog.
 *  - Não falar por cima de gente: na 1ª frase da resposta, se alguém (humano) está falando, espera até
 *    4 s (de 100 em 100 ms, cancelável) e fala assim mesmo. Os eventos de fala que chegam antes de o
 *    servidor ter fila ficam guardados e são herdados pelo GuildSpeaker ao nascer.
 *  - `manager.warmup()` aquece o codificador Opus (a partida a frio parava o laço de eventos ~100-270 ms).
 *  - DAVE (criptografia ponta a ponta): a biblioteca expõe `connection.voicePrivacyCode`,
 *    que fica vazio até o MLS fechar. Falar antes disso pode sair sem E2EE ou perder o início.
 *    Esperamos o código (até 3 s) SÓ quando há sessão DAVE com protocolo > 0 na conexão;
 *    sem DAVE (opção desligada, protocolo 0, biblioteca antiga) a espera é pulada e o motivo
 *    é registrado uma vez.
 *
 * Privacidade: logs só com metadados (servidor, usuário, razão, contagens, ms). Nunca o texto
 * falado. Erros entram no log só pelo código/nome, nunca pela `message` crua (pode carregar
 * trechos de texto, caminho ou saída de processo).
 *
 * Este módulo é puro ao importar: sem timers, sem processos, sem banco, sem carregar o
 * `@discordjs/voice` nem o logger do projeto (ambos são carregados sob demanda quando não
 * foram injetados). Tudo é injetável: conexão, player, recurso, relógio, timers.
 *
 * ATENÇÃO (registro de conexões): o `@discordjs/voice` tem duas cópias (dist/index.mjs para `import` e
 * dist/index.js para `require`) e CADA UMA tem o seu próprio registro de conexões. O voiceHandler entra na
 * call pelo `import` (ESM); se este módulo consultasse a cópia CJS, `getVoiceConnection(guildId)` voltaria
 * sempre vazio e a Yui nunca falaria. Por isso o bot passa em `options.voice` o MESMO módulo ESM que o
 * voiceHandler usa (initTts faz o `import('@discordjs/voice')`). O `require` abaixo é só o plano B de quem
 * criar o gerenciador fora do bot.
 */

import { createRequire } from 'node:module';
import { getTtsConfig } from './config.js';
import { attachConnectionSafety, attachPlayerSafety } from '../../utils/voiceSafety.js';

/** Constantes de tempo e tamanho (exportadas para os testes e para ajuste fino). */
export const OUTPUT_LIMITS = Object.freeze({
  /** 20 ms de PCM estéreo 48 kHz s16le; o codificador Opus descarta o que sobra disso. */
  frameBytes: 3840,
  /** 48.000 Hz x 2 canais x 2 bytes / 1000. */
  bytesPerMs: 192,
  /** Quantas frases à frente da que toca já podem estar sintetizadas (memória: PCM é grande). */
  prefetchAhead: 2,
  /** Depois do Idle, quanto esperar a próxima frase ficar pronta antes de encerrar a resposta. */
  nextSentenceWaitMs: 8_000,
  /** A 1ª frase pode precisar de partida a frio do motor (SAPI frio chega a 15 s). */
  firstSentenceWaitMs: 20_000,
  /** Folga acima de `maxSeconds` antes de o watchdog cortar a fala. */
  watchdogExtraMs: 5_000,
  /** Recurso que não sai de Buffering é sinal de pipeline quebrado. */
  bufferingTimeoutMs: 8_000,
  /** `Disconnected` vira desconexão de verdade só se não reconectar neste prazo. */
  reconnectGraceMs: 5_000,
  /** Espera do código de privacidade (DAVE) antes da 1ª fala numa conexão. */
  privacyWaitMs: 3_000,
  privacyPollMs: 100,
  /** Se alguém está falando quando a resposta fica pronta, espera até aqui (de 100 em 100 ms) e fala mesmo assim. */
  quietWaitMs: 4_000,
  quietPollMs: 100,
  /** Janela do barge-in: tempo de fala humana é somado dentro dela. */
  bargeWindowMs: 2_000,
  /** Um "está falando" sem o "parou" correspondente não vale para sempre (= teto de trecho do STT). */
  maxOpenSpeechMs: 120_000,
  /** Teto de frases por resposta aceito pela fila. */
  maxSentences: 50,
  /** Quanto tempo as janelas de fala antigas ficam guardadas para o anti-eco. */
  echoHistoryMs: 150_000,
});

const LIMITS = OUTPUT_LIMITS;

const NOOP = () => {};
/** Log mudo para os ajudantes de voiceSafety, que gravariam `message` crua. */
const SILENT_LOG = Object.freeze({ info: NOOP, warn: NOOP, error: NOOP, debug: NOOP });

const WHY_NO_API = 'a biblioteca de voz não expõe voicePrivacyCode';
const WHY_NO_SESSION = 'sem sessão DAVE na conexão (criptografia ponta a ponta desligada ou não negociada)';
const WHY_V0 = 'protocolo DAVE 0 (canal sem criptografia ponta a ponta)';
const WHY_STAGE = 'canal de palco';

// ── Utilidades ────────────────────────────────────────────────────────

/** Etiqueta segura para log: só caracteres simples e tamanho curto. */
function safeTag(value, fallback = 'desconhecido') {
  const s = String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
  return s || fallback;
}

/** Código/nome do erro, nunca a mensagem. */
function errTag(err) {
  return safeTag(err?.code || err?.name, 'ERRO');
}

function unref(handle) {
  try { handle?.unref?.(); } catch { /* timer falso pode não ter unref */ }
  return handle;
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function isValidPcm(buf) {
  return Buffer.isBuffer(buf) && buf.length >= LIMITS.frameBytes;
}

function destroyQuietly(stream) {
  try { stream?.destroy?.(); } catch { /* já destruído */ }
}

// ── Carregamento sob demanda (mantém o import sem efeitos) ─────────────

const nodeRequire = createRequire(import.meta.url);
let realVoice = null;

function loadVoice() {
  realVoice ??= nodeRequire('@discordjs/voice');
  return realVoice;
}

function pickLib(voice) {
  return {
    AudioPlayerStatus: voice.AudioPlayerStatus,
    VoiceConnectionStatus: voice.VoiceConnectionStatus,
    StreamType: voice.StreamType,
    NoSubscriberBehavior: voice.NoSubscriberBehavior,
  };
}

let audioModule = null;
/** Padrão de `readableFromPcm`: o audio.js só é carregado se ninguém injetar outro. */
async function defaultReadableFromPcm(pcm) {
  audioModule ??= await import('./audio.js');
  return audioModule.pcmToReadable(pcm);
}

/** Logger padrão: carrega o logger do projeto na primeira mensagem (ele cria pasta de logs). */
function createLazyLogger() {
  const emit = (level) => (msg) => {
    import('../../utils/logger.js')
      .then((m) => m.logger[level](msg))
      .catch(NOOP);
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error'), debug: emit('debug') };
}

function buildConfig(config) {
  if (!config) return getTtsConfig();
  return { ...getTtsConfig({}), ...config };
}

// ── DAVE ──────────────────────────────────────────────────────────────

/** Há criptografia ponta a ponta de verdade nesta conexão (a ponto de valer esperar o código)? */
function readDave(conn) {
  try {
    if (!('voicePrivacyCode' in conn)) return { active: false, why: WHY_NO_API };
    const dave = conn?.state?.networking?.state?.dave;
    if (!dave) return { active: false, why: WHY_NO_SESSION };
    if (Number(dave.protocolVersion) === 0) return { active: false, why: WHY_V0 };
    return { active: true, why: '' };
  } catch {
    return { active: false, why: WHY_NO_SESSION };
  }
}

function readPrivacyCode(conn) {
  try { return conn.voicePrivacyCode || null; } catch { return null; }
}

// ── GuildSpeaker ──────────────────────────────────────────────────────

class GuildSpeaker {
  /** @param {Map<string, number>} [alreadySpeaking] quem já falava antes de este servidor ter fila (userId -> início) */
  constructor(ctx, guildId, alreadySpeaking) {
    this.ctx = ctx;
    this.guildId = guildId;
    this.generation = 0;
    this.disposed = false;

    this.queue = []; // entradas esperando (não inclui a que está em andamento)
    this.current = null; // "run" em andamento

    this.player = null;
    this.playerHandlers = null;

    this.connection = null; // conexão em que assinamos
    this.connHandlers = null;
    this.reconnecting = false;

    this.waiters = new Set(); // esperas canceláveis (síntese, DAVE)

    this.windows = []; // janelas em que a Yui falou: { start, end | null }

    this.speakingUsers = new Map(alreadySpeaking ?? []); // userId -> quando começou a falar
    this.bargeSegs = []; // trechos de fala do dono do pedido DURANTE a fala da Yui
    this.bargeTimer = null;
  }

  // ── infraestrutura ──

  log(level, msg) {
    try { this.ctx.log[level]?.(msg); } catch { /* log nunca derruba a fala */ }
  }

  setTimer(fn, ms) {
    return unref(this.ctx.timers.setTimeout(fn, ms));
  }

  clearTimer(handle) {
    if (handle == null) return;
    try { this.ctx.timers.clearTimeout(handle); } catch { /* ignora */ }
  }

  /** Espera `ms`; resolve true se o tempo passou, false se foi cancelada (interrupção). */
  sleep(ms) {
    return new Promise((resolve) => {
      let handle = null;
      const rec = {
        cancel: () => {
          this.clearTimer(handle);
          this.waiters.delete(rec);
          resolve(false);
        },
      };
      handle = this.setTimer(() => {
        this.waiters.delete(rec);
        resolve(true);
      }, ms);
      this.waiters.add(rec);
    });
  }

  /**
   * Espera a promessa por no máximo `ms`. Resolve sempre (nunca rejeita) com
   * { value } | { failed } | { timedOut } | { aborted } (cancelada por interrupção).
   */
  waitFor(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      let handle = null;
      const settle = (result) => {
        if (done) return;
        done = true;
        this.clearTimer(handle);
        this.waiters.delete(rec);
        resolve(result);
      };
      const rec = { cancel: () => settle({ aborted: true }) };
      handle = this.setTimer(() => settle({ timedOut: true }), ms);
      this.waiters.add(rec);
      promise.then((value) => settle({ value }), () => settle({ failed: true }));
    });
  }

  cancelWaiters() {
    for (const rec of [...this.waiters]) rec.cancel();
    this.waiters.clear();
  }

  /** O "run" ainda é o dono da vez? (nada de ações de uma geração/resposta velha) */
  live(run) {
    return !this.disposed && !run.finished && this.current === run && run.gen === this.generation;
  }

  logOnce(key, level, msg) {
    if (this.ctx.onceKeys.has(key)) return;
    this.ctx.onceKeys.add(key);
    this.log(level, msg);
  }

  // ── fila ──

  /** Entrada já validada pelo gerenciador. */
  accept(entry) {
    const cfg = this.ctx.cfg;
    const finishes = [];
    let dropped = 0;

    // No máx. 1 pendente por usuário: o pedido novo substitui o antigo dele.
    if (entry.userId) {
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        if (this.queue[i].userId === entry.userId) {
          finishes.push(this.dropWaiting(i, 'replaced'));
          dropped += 1;
        }
      }
    }

    // Fila cheia (contando o que toca): sai o MAIS ANTIGO que espera.
    while (this.queue.length + (this.current ? 1 : 0) >= cfg.queueMax) {
      if (this.queue.length === 0) {
        // Só há o que está tocando e a fila não comporta mais ninguém.
        this.flushFinishes(finishes);
        return { ok: false, reason: 'queue-full' };
      }
      finishes.push(this.dropWaiting(0, 'overflow'));
      dropped += 1;
    }

    this.queue.push(entry);
    const position = this.queue.length;
    this.flushFinishes(finishes);
    this.pump();
    return { ok: true, dropped, position };
  }

  dropWaiting(index, reason) {
    const [entry] = this.queue.splice(index, 1);
    entry.abort.abort();
    return [entry, this.dropInfo(entry, reason)];
  }

  dropInfo(entry, reason) {
    return { reason, spokenMs: 0, sentencesPlayed: 0, sentencesTotal: entry.count, firstSoundAt: null };
  }

  isStale(entry) {
    const requestedAt = Number(entry.job.requestedAt);
    if (!Number.isFinite(requestedAt)) return false;
    return this.ctx.now() - requestedAt > this.ctx.cfg.staleSeconds * 1000;
  }

  /** Começa a próxima resposta da fila (se não houver uma em andamento). */
  pump() {
    if (this.disposed || this.current) return;
    const finishes = [];
    while (!this.current && this.queue.length > 0) {
      const entry = this.queue.shift();
      // Validade conferida na RETIRADA: pedido que esperou demais não é mais atual.
      if (this.isStale(entry)) {
        entry.abort.abort();
        finishes.push([entry, this.dropInfo(entry, 'stale')]);
        continue;
      }
      this.startRun(entry);
    }
    this.flushFinishes(finishes);
  }

  startRun(entry) {
    const run = {
      entry,
      gen: this.generation,
      cursor: 0, // índice da frase que toca/está sendo esperada
      sentencesPlayed: 0,
      spokenMs: 0,
      nowPlaying: null, // { gen, index, resource, startedAt, durationMs }
      audioStartedAt: null,
      watchdog: null,
      bufferTimer: null,
      finished: false,
    };
    this.current = run;
    this.advance(run).catch(() => this.finishRun(run, 'error'));
  }

  // ── síntese (prefetch) ──

  /** Garante que as frases de `cursor` até `cursor + prefetchAhead` já foram pedidas. */
  topUp(run) {
    const { entry } = run;
    const last = Math.min(entry.count - 1, run.cursor + LIMITS.prefetchAhead);
    for (let i = entry.slots.length; i <= last; i += 1) this.startSlot(entry, i);
  }

  startSlot(entry, index) {
    const slot = { index, status: 'pending', pcm: null, promise: null };
    entry.slots[index] = slot;
    let call;
    try {
      call = Promise.resolve(entry.job.synth(index, entry.abort.signal));
    } catch (err) {
      call = Promise.reject(err);
    }
    slot.promise = call.then(
      (pcm) => {
        if (isValidPcm(pcm)) {
          slot.status = 'ready';
          slot.pcm = pcm;
          return { pcm };
        }
        slot.status = 'failed';
        return { failed: 'empty' };
      },
      (err) => {
        slot.status = 'failed';
        const aborted = entry.abort.signal.aborted || err?.code === 'ABORTED';
        if (!aborted) {
          this.log('warn', `[TTS] Síntese falhou (servidor ${this.guildId}, frase ${index}): ${errTag(err)}`);
        }
        return { failed: aborted ? 'aborted' : errTag(err) };
      },
    );
  }

  /** Espera o PCM da frase `index`. Devolve { pcm } ou { reason }. */
  async waitSentence(run, index, ms) {
    this.topUp(run);
    const slot = run.entry.slots[index];
    if (!slot?.promise) return { reason: 'synth-failed' };
    const res = await this.waitFor(slot.promise, ms);
    if (res.aborted) return { reason: 'aborted' };
    if (res.timedOut) return { reason: index === 0 ? 'synth-timeout' : 'next-sentence-timeout' };
    const value = res.value;
    if (!value?.pcm) return { reason: value?.failed === 'aborted' ? 'aborted' : 'synth-failed' };
    return { pcm: value.pcm };
  }

  // ── reprodução ──

  /** Toca a frase `run.cursor` (ou encerra a resposta se acabaram). Nunca rejeita. */
  async advance(run) {
    const ctx = this.ctx;
    let resource = null;
    let played = false;
    try {
      if (!this.live(run)) return;
      const index = run.cursor;
      const { entry } = run;
      if (index >= entry.count) {
        this.finishRun(run, 'done');
        return;
      }

      const got = await this.waitSentence(run, index, index === 0 ? LIMITS.firstSentenceWaitMs : LIMITS.nextSentenceWaitMs);
      if (!this.live(run)) return;
      if (!got.pcm) {
        this.finishRun(run, got.reason);
        return;
      }

      // Não falar por cima de gente: na 1ª frase da resposta, se alguém está falando, espera até 4 s e
      // fala mesmo assim (T1 1.4). O gate abaixo e a conexão são conferidos DEPOIS da espera.
      if (run.audioStartedAt === null) {
        await this.waitForQuiet(run);
        if (!this.live(run)) return;
      }

      // Gate opcional por frase (ex.: o interruptor do servidor foi desligado no meio).
      if (typeof entry.job.canSpeak === 'function') {
        let allowed = false;
        try { allowed = !!entry.job.canSpeak(index); } catch { allowed = false; }
        if (!allowed) {
          this.finishRun(run, 'not-allowed');
          return;
        }
      }

      const prep = await this.prepareConnection(run);
      if (!this.live(run)) return;
      if (!prep.ok) {
        this.finishRun(run, prep.reason);
        return;
      }

      const readable = await ctx.readableFromPcm(got.pcm);
      if (!this.live(run)) {
        destroyQuietly(readable);
        return;
      }
      // Este é o último `await` antes do play. Durante os anteriores (espera do DAVE de até 3 s, preparo do
      // stream) o rádio pode ter ligado, a conexão pode ter caído ou outro player pode ter tomado a assinatura:
      // confere de novo, senão a frase sairia por cima da música ou para ninguém.
      const still = this.stillCanPlay();
      if (!still.ok) {
        destroyQuietly(readable);
        this.finishRun(run, still.reason);
        return;
      }

      try {
        resource = ctx.createResource(readable, { inputType: ctx.lib.StreamType.Raw });
      } catch (err) {
        destroyQuietly(readable);
        throw err;
      }

      const startedAt = ctx.now();
      run.nowPlaying = {
        gen: run.gen,
        index,
        resource,
        startedAt,
        durationMs: got.pcm.length / LIMITS.bytesPerMs,
      };
      entry.slots[index] = { index, status: 'played', pcm: null, promise: null }; // solta o PCM
      const first = run.audioStartedAt === null;
      if (first) {
        run.audioStartedAt = startedAt;
        this.openWindow(startedAt);
        this.armWatchdog(run);
      }

      this.player.play(resource);
      played = true;
      this.armBufferTimer(run);
      // Quem já estava falando por cima quando a Yui começou conta a partir daqui.
      if (first) this.evaluateBarge();
    } catch (err) {
      if (resource && !played) destroyQuietly(resource.playStream);
      this.log('warn', `[TTS] Falha ao tocar (servidor ${this.guildId}): ${errTag(err)}`);
      this.finishRun(run, 'error');
    }
  }

  ensurePlayer() {
    if (this.player) return this.player;
    const { ctx } = this;
    const { AudioPlayerStatus, NoSubscriberBehavior } = ctx.lib;
    const player = ctx.createPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 5 },
    });
    // Sem ouvinte de 'error' o erro do stream vira exceção não tratada.
    attachPlayerSafety(player, { label: 'TTS', guildId: this.guildId, log: SILENT_LOG });
    const handlers = {
      error: (err) => this.log('warn', `[TTS] Erro no player (servidor ${this.guildId}): ${errTag(err)}`),
      idle: (oldState) => this.onPlayerIdle(oldState),
      playing: () => this.onPlayerPlaying(),
      autopaused: () => this.onPlayerAutoPaused(),
    };
    player.on('error', handlers.error);
    player.on(AudioPlayerStatus.Idle, handlers.idle);
    player.on(AudioPlayerStatus.Playing, handlers.playing);
    player.on(AudioPlayerStatus.AutoPaused, handlers.autopaused);
    this.player = player;
    this.playerHandlers = handlers;
    return player;
  }

  onPlayerIdle(oldState) {
    const run = this.current;
    if (!run || run.finished) return;
    const np = run.nowPlaying;
    // Idle de geração velha (ou de outro recurso) NUNCA toca a próxima frase.
    if (!np || np.gen !== this.generation || run.gen !== this.generation) return;
    const ended = oldState?.resource;
    if (ended && np.resource && ended !== np.resource) return;

    this.clearBufferTimer(run);
    run.nowPlaying = null;
    run.sentencesPlayed += 1;
    run.spokenMs += Math.min(np.durationMs, Math.max(0, this.ctx.now() - np.startedAt));
    run.cursor = np.index + 1;
    this.advance(run).catch(() => this.finishRun(run, 'error'));
  }

  onPlayerPlaying() {
    if (this.current) this.clearBufferTimer(this.current);
  }

  onPlayerAutoPaused() {
    const run = this.current;
    if (!run) return;
    // Sem assinante: se foi o rádio que levou a conexão, a fala não tem mais como sair.
    if (this.radioActive()) {
      this.interrupt('radio');
      return;
    }
    // Sem rádio marcado, mas a assinatura foi para outro player (rádio ainda subindo, entrada repetida na
    // call) ou sumiu: o Idle nunca chega e ninguém reassina. Encerra só esta resposta agora, em vez de
    // deixar a fila presa até o watchdog (30 s). A próxima da fila reassina em prepareConnection.
    const sub = this.connection?.state?.subscription;
    if (!sub || sub.player !== this.player) this.finishRun(run, 'unsubscribed');
  }

  armWatchdog(run) {
    const ms = this.ctx.cfg.maxSeconds * 1000 + LIMITS.watchdogExtraMs;
    run.watchdog = this.setTimer(() => {
      run.watchdog = null;
      if (!this.live(run)) return;
      this.log('warn', `[TTS] Watchdog: fala acima do limite (servidor ${this.guildId}); interrompendo.`);
      this.interrupt('watchdog');
    }, ms);
  }

  /** Recurso que não sai de Buffering em 8 s: encerra só esta resposta. */
  armBufferTimer(run) {
    const status = this.player?.state?.status;
    if (status !== this.ctx.lib.AudioPlayerStatus.Buffering) return;
    const np = run.nowPlaying;
    run.bufferTimer = this.setTimer(() => {
      run.bufferTimer = null;
      if (!this.live(run) || run.nowPlaying !== np) return;
      this.log('warn', `[TTS] Recurso preso em Buffering (servidor ${this.guildId}); encerrando a resposta.`);
      this.finishRun(run, 'buffering-timeout');
    }, LIMITS.bufferingTimeoutMs);
  }

  clearBufferTimer(run) {
    if (run.bufferTimer !== null) {
      this.clearTimer(run.bufferTimer);
      run.bufferTimer = null;
    }
  }

  stopPlayer() {
    try { this.player?.stop(true); } catch (err) {
      this.log('warn', `[TTS] Falha ao parar o player (servidor ${this.guildId}): ${errTag(err)}`);
    }
  }

  // ── conexão ──

  radioActive() {
    // Se a checagem falhar, assume rádio ativo: na dúvida não assina nem fala por cima.
    try { return !!this.ctx.isRadioActive(this.guildId); } catch { return true; }
  }

  /** Alguém (humano) está falando agora? "Começou" sem o "parou" correspondente deixa de valer após maxOpenSpeechMs. */
  hasHumanSpeaking() {
    const t = this.ctx.now();
    for (const since of this.speakingUsers.values()) {
      if (t - since <= LIMITS.maxOpenSpeechMs) return true;
    }
    return false;
  }

  /** Espera até `quietWaitMs` (de 100 em 100 ms, cancelável) enquanto houver gente falando; depois fala assim mesmo. */
  async waitForQuiet(run) {
    const polls = Math.ceil(LIMITS.quietWaitMs / LIMITS.quietPollMs);
    for (let i = 0; i < polls && this.hasHumanSpeaking(); i += 1) {
      const slept = await this.sleep(LIMITS.quietPollMs);
      if (!slept || !this.live(run)) return;
    }
  }

  /**
   * Conferência final antes do `play`: rádio parado, a conexão em que assinamos é a atual e está Ready, e o
   * player ainda é o assinante dela. (prepareConnection já conferiu isso, mas antes de esperas assíncronas.)
   */
  stillCanPlay() {
    if (this.radioActive()) return { ok: false, reason: 'radio-active' };
    const conn = this.connection;
    let current = null;
    try { current = this.ctx.getConnection(this.guildId) ?? null; } catch { current = null; }
    if (!conn || current !== conn) return { ok: false, reason: 'no-connection' };
    if (conn.state?.status !== this.ctx.lib.VoiceConnectionStatus.Ready) return { ok: false, reason: 'not-ready' };
    if (conn.state?.subscription?.player !== this.player) return { ok: false, reason: 'unsubscribed' };
    return { ok: true };
  }

  /** Confere rádio, conexão Ready, identidade e assinatura; espera o DAVE na 1ª vez. */
  async prepareConnection(run) {
    const { ctx } = this;
    if (this.radioActive()) return { ok: false, reason: 'radio-active' };

    let conn = null;
    try { conn = ctx.getConnection(this.guildId) ?? null; } catch { conn = null; }
    if (!conn) return { ok: false, reason: 'no-connection' };
    if (conn.state?.status !== ctx.lib.VoiceConnectionStatus.Ready) return { ok: false, reason: 'not-ready' };

    const player = this.ensurePlayer();
    this.bindConnection(conn);

    // Reassina se a conexão mudou OU se outro player (o do rádio) levou a assinatura.
    if (conn.state?.subscription?.player !== player) {
      let subscription;
      try { subscription = conn.subscribe(player); } catch { subscription = null; }
      if (!subscription) return { ok: false, reason: 'no-connection' };
    }

    await this.waitPrivacyCode(run, conn);
    return { ok: true };
  }

  bindConnection(conn) {
    if (this.connection === conn) return;
    this.unbindConnection();
    const { ctx } = this;
    if (!ctx.safeConns.has(conn)) {
      attachConnectionSafety(conn, { label: 'TTS', guildId: this.guildId, log: SILENT_LOG });
      ctx.safeConns.add(conn);
    }
    const handlers = {
      error: (err) => this.log('warn', `[TTS] Erro na conexão de voz (servidor ${this.guildId}): ${errTag(err)}`),
      disconnected: () => { this.handleDisconnected(conn).catch(NOOP); },
      destroyed: () => {
        if (this.connection === conn) this.dispose('connection-destroyed');
      },
    };
    conn.on('error', handlers.error);
    conn.on(ctx.lib.VoiceConnectionStatus.Disconnected, handlers.disconnected);
    conn.on(ctx.lib.VoiceConnectionStatus.Destroyed, handlers.destroyed);
    this.connection = conn;
    this.connHandlers = handlers;
  }

  unbindConnection() {
    const conn = this.connection;
    if (!conn) return;
    const handlers = this.connHandlers;
    this.connection = null;
    this.connHandlers = null;
    const { VoiceConnectionStatus } = this.ctx.lib;
    try {
      conn.off('error', handlers.error);
      conn.off(VoiceConnectionStatus.Disconnected, handlers.disconnected);
      conn.off(VoiceConnectionStatus.Destroyed, handlers.destroyed);
    } catch { /* conexão já descartada */ }
    // Não deixa o player assinado numa conexão que não usamos mais.
    try {
      const sub = conn.state?.subscription;
      if (sub && this.player && sub.player === this.player) sub.unsubscribe?.();
    } catch { /* ignora */ }
  }

  /**
   * `Disconnected` costuma ser uma reconexão em andamento (troca de região do servidor
   * de voz, por exemplo). Só descarta se não houver Signalling/Connecting em 5 s.
   */
  async handleDisconnected(conn) {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    const { ctx } = this;
    const { VoiceConnectionStatus } = ctx.lib;
    const abort = new AbortController();
    const timer = this.setTimer(() => abort.abort(), LIMITS.reconnectGraceMs);
    let recovered = false;
    try {
      await Promise.any([
        ctx.entersState(conn, VoiceConnectionStatus.Signalling, abort.signal),
        ctx.entersState(conn, VoiceConnectionStatus.Connecting, abort.signal),
      ]);
      recovered = true;
    } catch {
      recovered = false;
    } finally {
      this.clearTimer(timer);
      abort.abort(); // solta o ouvinte do estado que não aconteceu
      this.reconnecting = false;
    }
    if (this.disposed || this.connection !== conn) return;
    if (recovered) {
      this.log('info', `[TTS] Conexão de voz reconectando (servidor ${this.guildId}); mantendo a fila.`);
      return;
    }
    this.dispose('connection-lost');
  }

  /** Espera o código de privacidade (DAVE) na 1ª fala de cada conexão. */
  async waitPrivacyCode(run, conn) {
    const { ctx } = this;
    if (ctx.privacySeen.has(conn)) return;
    ctx.privacySeen.add(conn);

    const dave = readDave(conn);
    if (!dave.active) {
      this.logOnce(`dave:${dave.why}`, 'info', `[TTS] Espera do código de privacidade (DAVE) dispensada: ${dave.why}.`);
      return;
    }
    let stage = false;
    try { stage = !!ctx.isStageChannel?.(this.guildId, conn); } catch { stage = false; }
    if (stage) {
      this.logOnce(`dave:${WHY_STAGE}`, 'info', `[TTS] Espera do código de privacidade (DAVE) dispensada: ${WHY_STAGE}.`);
      return;
    }

    const polls = Math.ceil(LIMITS.privacyWaitMs / LIMITS.privacyPollMs);
    for (let i = 0; i < polls; i += 1) {
      if (readPrivacyCode(conn)) return;
      const slept = await this.sleep(LIMITS.privacyPollMs);
      if (!slept || !this.live(run)) return;
    }
    if (readPrivacyCode(conn)) return;
    this.logOnce(
      'dave:timeout',
      'warn',
      `[TTS] Código de privacidade (DAVE) não apareceu em ${LIMITS.privacyWaitMs} ms; falando assim mesmo.`,
    );
  }

  // ── encerramento ──

  /**
   * Fecha o estado de uma resposta sem chamar callbacks nem avançar a fila.
   * Devolve [entry, info] para o chamador notificar (ou null se já estava fechada).
   */
  closeRun(run, reason) {
    if (run.finished) return null;
    run.finished = true;
    this.clearTimer(run.watchdog);
    run.watchdog = null;
    this.clearBufferTimer(run);
    // Frase cortada no meio: conta só o que de fato foi ao ar.
    if (run.nowPlaying) {
      const np = run.nowPlaying;
      run.spokenMs += Math.min(np.durationMs, Math.max(0, this.ctx.now() - np.startedAt));
      run.nowPlaying = null;
    }
    if (this.current === run) this.current = null;
    run.entry.abort.abort();
    run.entry.slots.length = 0; // solta o PCM que sobrou
    if (run.audioStartedAt !== null) this.closeWindow();
    this.resetBarge();
    return [
      run.entry,
      {
        reason,
        spokenMs: Math.round(run.spokenMs),
        sentencesPlayed: run.sentencesPlayed,
        sentencesTotal: run.entry.count,
        firstSoundAt: run.audioStartedAt,
      },
    ];
  }

  /** Encerra só esta resposta (a fila segue). */
  finishRun(run, reason) {
    const finished = this.closeRun(run, reason);
    if (!finished) return;
    // Se ainda houver algo no ar (ex.: falha na frase seguinte), corta.
    this.stopPlayer();
    this.flushFinishes([finished]);
    this.pump();
  }

  /** Interrompe a fala: aborta sínteses, limpa a fila e para o player. */
  interrupt(reason) {
    if (this.disposed) return false;
    const tag = safeTag(reason, 'interrupted');
    const run = this.current;
    const waiting = this.queue.splice(0);
    if (!run && waiting.length === 0) return false;

    this.generation += 1; // 1) a partir daqui, Idle de antes não vale mais
    this.cancelWaiters(); // 2) acorda quem esperava síntese/DAVE (vai ver que perdeu a vez)

    const finishes = [];
    for (const entry of waiting) {
      entry.abort.abort();
      finishes.push([entry, this.dropInfo(entry, tag)]);
    }
    if (run) {
      const finished = this.closeRun(run, tag);
      if (finished) finishes.push(finished);
    }
    this.stopPlayer(); // 3) só agora, com o estado já limpo (o Idle resultante é ignorado)
    this.log('info', `[TTS] Fala interrompida (servidor ${this.guildId}): motivo=${tag}, descartados=${finishes.length}.`);
    this.flushFinishes(finishes);
    return true;
  }

  /** Descarta tudo deste servidor (saiu da call, conexão caiu ou foi destruída). */
  dispose(reason = 'disposed') {
    if (this.disposed) return false;
    this.disposed = true;
    const tag = safeTag(reason, 'disposed');
    this.generation += 1;
    this.cancelWaiters();
    this.clearBargeTimer();

    const finishes = [];
    for (const entry of this.queue.splice(0)) {
      entry.abort.abort();
      finishes.push([entry, this.dropInfo(entry, tag)]);
    }
    if (this.current) {
      const finished = this.closeRun(this.current, tag);
      if (finished) finishes.push(finished);
    }
    this.current = null;
    this.stopPlayer();

    if (this.player && this.playerHandlers) {
      const { AudioPlayerStatus } = this.ctx.lib;
      const h = this.playerHandlers;
      try {
        // O ouvinte de 'error' fica de propósito: um erro tardio não pode virar exceção.
        this.player.off(AudioPlayerStatus.Idle, h.idle);
        this.player.off(AudioPlayerStatus.Playing, h.playing);
        this.player.off(AudioPlayerStatus.AutoPaused, h.autopaused);
      } catch { /* ignora */ }
    }
    this.unbindConnection();
    this.windows = [];
    this.speakingUsers.clear();
    this.bargeSegs = [];
    this.ctx.speakers.delete(this.guildId);
    this.log('info', `[TTS] Saída de áudio descartada (servidor ${this.guildId}): motivo=${tag}.`);
    this.flushFinishes(finishes);
    return true;
  }

  flushFinishes(list) {
    for (const [entry, info] of list) {
      this.log(
        info.reason === 'error' ? 'warn' : 'info',
        `[TTS] Fala encerrada (servidor ${this.guildId}, usuário ${safeTag(entry.userId, '-')}): ` +
          `motivo=${safeTag(info.reason)}, frases=${info.sentencesPlayed}/${info.sentencesTotal}, falado=${info.spokenMs}ms.`,
      );
      try {
        const out = entry.job.onFinish?.(info);
        if (out && typeof out.catch === 'function') out.catch(NOOP);
      } catch (err) {
        this.log('warn', `[TTS] onFinish lançou erro (servidor ${this.guildId}): ${errTag(err)}`);
      }
    }
  }

  // ── janela de eco ──

  openWindow(start) {
    const { ctx } = this;
    const limit = start - LIMITS.echoHistoryMs - ctx.cfg.echoGuardMs;
    this.windows = this.windows.filter((w) => w.end === null || w.end >= limit).slice(-19);
    this.windows.push({ start, end: null });
  }

  closeWindow() {
    const last = this.windows[this.windows.length - 1];
    if (last && last.end === null) last.end = this.ctx.now();
  }

  /** [startMs, endMs] cruza algum [início, fim + margem] (ou a fala em andamento)? */
  overlapsSpeech(startMs, endMs) {
    let a = Number(startMs);
    let b = Number(endMs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (b < a) [a, b] = [b, a];
    const guard = this.ctx.cfg.echoGuardMs;
    for (const w of this.windows) {
      const wEnd = w.end === null ? Infinity : w.end + guard;
      if (a <= wEnd && b >= w.start) return true;
    }
    return false;
  }

  // ── barge-in ──

  clearBargeTimer() {
    if (this.bargeTimer !== null) {
      this.clearTimer(this.bargeTimer);
      this.bargeTimer = null;
    }
  }

  resetBarge() {
    this.clearBargeTimer();
    this.bargeSegs = [];
  }

  /**
   * Registra que `userId` começou/parou de falar. Idempotente: "começou" repetido não
   * reinicia a contagem e "parou" sem "começou" é ignorado.
   */
  noteHuman(userId, speaking) {
    const uid = userId == null ? '' : String(userId);
    if (!uid) return;
    const t = this.ctx.now();
    if (speaking) {
      if (!this.speakingUsers.has(uid)) {
        this.speakingUsers.set(uid, t);
        if (this.speakingUsers.size > 64) {
          // Proteção contra "parou" que nunca chegou: descarta o mais antigo.
          this.speakingUsers.delete(this.speakingUsers.keys().next().value);
        }
      }
    } else {
      const since = this.speakingUsers.get(uid);
      if (since === undefined) return;
      this.speakingUsers.delete(uid);
      const run = this.current;
      if (run && run.audioStartedAt !== null && uid === run.entry.userId) {
        const start = Math.max(since, run.audioStartedAt);
        if (t > start) this.bargeSegs.push({ start, end: t });
      }
    }
    this.evaluateBarge();
  }

  /**
   * Soma o tempo de fala do DONO do pedido em curso dentro da janela e interrompe ao
   * atingir `bargeInMs`. Se ele ainda está falando, agenda a reavaliação para o instante
   * em que a soma bateria o limite (o "parou" pode demorar a chegar).
   */
  evaluateBarge() {
    this.clearBargeTimer();
    const { cfg, now } = this.ctx;
    const run = this.current;
    if (this.disposed || !cfg.bargeIn || !run || run.audioStartedAt === null || run.finished) return;

    const owner = run.entry.userId;
    if (!owner) return;
    const t = now();
    const windowMs = Math.max(LIMITS.bargeWindowMs, cfg.bargeInMs * 2);
    const from = t - windowMs;

    this.bargeSegs = this.bargeSegs.filter((s) => s.end > from);
    let total = 0;
    for (const s of this.bargeSegs) total += overlap(s.start, s.end, from, t);

    let since = this.speakingUsers.get(owner);
    if (since !== undefined && t - since > LIMITS.maxOpenSpeechMs) {
      this.speakingUsers.delete(owner); // "parou" perdido: não vale para sempre
      since = undefined;
    }
    if (since !== undefined) total += overlap(Math.max(since, run.audioStartedAt), t, from, t);

    if (total >= cfg.bargeInMs) {
      this.log('info', `[TTS] Barge-in (servidor ${this.guildId}, usuário ${safeTag(owner, '-')}): ${Math.round(total)}ms de fala.`);
      this.interrupt('barge-in');
      return;
    }
    if (since !== undefined) {
      const wait = Math.max(10, Math.ceil(cfg.bargeInMs - total));
      this.bargeTimer = this.setTimer(() => {
        this.bargeTimer = null;
        this.evaluateBarge();
      }, wait);
    }
  }

  // ── consulta ──

  status() {
    const run = this.current;
    return {
      guildId: this.guildId,
      speaking: !!run,
      audible: !!(run && run.nowPlaying),
      queued: this.queue.length,
      generation: this.generation,
      connected: !!this.connection,
      hasPlayer: !!this.player,
    };
  }
}

// ── Gerenciador ───────────────────────────────────────────────────────

function buildEntry(job) {
  if (!job || typeof job.synth !== 'function') return null;
  const count = Math.floor(Number(job.count));
  if (!Number.isFinite(count) || count < 1 || count > LIMITS.maxSentences) return null;
  return {
    job,
    userId: job.userId == null ? '' : String(job.userId),
    count,
    abort: new AbortController(),
    slots: [],
  };
}

/**
 * Cria o gerenciador de falas (um GuildSpeaker por servidor, criado sob demanda).
 * Todas as dependências são opcionais e têm padrão (o @discordjs/voice real, o relógio
 * do sistema e o `pcmToReadable` do audio.js); os testes injetam dublês.
 *
 * Extras além do contrato mínimo (todos opcionais):
 *  - `isStageChannel(guildId, connection)`: true pula a espera do código DAVE em palco;
 *  - `job.canSpeak(index)`: gate síncrono conferido antes de CADA frase (false encerra a
 *    resposta com a razão 'not-allowed');
 *  - `manager.disposeAll(reason)`: descarta todos os servidores (encerramento do bot);
 *  - `options.voice`: o módulo `@discordjs/voice` (namespace ESM) de onde saem as peças que não forem injetadas.
 *
 * @param {object} [options]
 * @returns {{
 *   enqueue(guildId: string, job: object): { ok: boolean, reason?: string, dropped?: number, position?: number },
 *   interrupt(guildId: string, reason?: string): boolean,
 *   dispose(guildId: string, reason?: string): boolean,
 *   disposeAll(reason?: string): number,
 *   isSpeaking(guildId: string): boolean,
 *   overlapsSpeech(guildId: string, startMs: number, endMs: number): boolean,
 *   noteHumanSpeaking(guildId: string, userId: string, speaking: boolean): void,
 *   warmup(): Promise<boolean>,
 *   getStatus(): object,
 * }}
 */
export function createSpeakerManager(options = {}) {
  const needsRealVoice = !(
    options.getConnection && options.createPlayer && options.createResource && options.entersState && options.voiceLib
  );
  // `options.voice` = o módulo @discordjs/voice que o bot inteiro usa (ESM). Veja o aviso no cabeçalho.
  const real = options.voice ?? (needsRealVoice ? loadVoice() : null);

  const ctx = {
    cfg: buildConfig(options.config),
    now: options.now ?? (() => Date.now()),
    timers: options.timers ?? { setTimeout, clearTimeout },
    log: options.logger ?? createLazyLogger(),
    lib: options.voiceLib ?? pickLib(real),
    getConnection: options.getConnection ?? ((guildId) => real.getVoiceConnection(guildId)),
    createPlayer: options.createPlayer ?? ((opts) => real.createAudioPlayer(opts)),
    createResource: options.createResource ?? ((input, opts) => real.createAudioResource(input, opts)),
    entersState: options.entersState ?? ((target, status, wait) => real.entersState(target, status, wait)),
    readableFromPcm: options.readableFromPcm ?? defaultReadableFromPcm,
    isRadioActive: options.isRadioActive ?? (() => false),
    isStageChannel: options.isStageChannel ?? null,
    onceKeys: new Set(),
    privacySeen: new WeakSet(),
    safeConns: new WeakSet(),
    speakers: new Map(),
    // Quem está falando num servidor que ainda não tem GuildSpeaker (1ª fala depois do boot ou do dispose):
    // guildId -> Map(userId -> início). O GuildSpeaker herda isso ao nascer, senão o barge-in e a espera
    // por silêncio ficariam cegos para quem já estava falando.
    preSpeaking: new Map(),
  };
  const MAX_PRE_GUILDS = 200;
  const MAX_PRE_USERS = 64;

  function notePreSpeaking(gid, userId, speaking) {
    const uid = userId == null ? '' : String(userId);
    if (!uid) return;
    let users = ctx.preSpeaking.get(gid);
    if (speaking) {
      if (!users) {
        if (ctx.preSpeaking.size >= MAX_PRE_GUILDS) ctx.preSpeaking.delete(ctx.preSpeaking.keys().next().value);
        users = new Map();
        ctx.preSpeaking.set(gid, users);
      }
      if (!users.has(uid)) {
        users.set(uid, ctx.now());
        if (users.size > MAX_PRE_USERS) users.delete(users.keys().next().value);
      }
    } else if (users) {
      users.delete(uid);
      if (users.size === 0) ctx.preSpeaking.delete(gid);
    }
  }

  let warming = null;

  const warn = (msg) => {
    try { ctx.log.warn?.(msg); } catch { /* log nunca derruba */ }
  };
  const idOf = (guildId) => (guildId == null ? '' : String(guildId));

  return {
    enqueue(guildId, job) {
      try {
        const gid = idOf(guildId);
        if (!gid) return { ok: false, reason: 'invalid-guild' };
        const entry = buildEntry(job);
        if (!entry) return { ok: false, reason: 'invalid-job' };
        // Com o rádio ativo a Yui não fala (assinar o player roubaria o áudio da música).
        let radio = false;
        try { radio = !!ctx.isRadioActive(gid); } catch { radio = true; }
        if (radio) return { ok: false, reason: 'radio-active' };
        let speaker = ctx.speakers.get(gid);
        if (!speaker) {
          const already = ctx.preSpeaking.get(gid);
          ctx.preSpeaking.delete(gid);
          speaker = new GuildSpeaker(ctx, gid, already);
          ctx.speakers.set(gid, speaker);
        }
        return speaker.accept(entry);
      } catch (err) {
        warn(`[TTS] Falha ao enfileirar (servidor ${safeTag(guildId)}): ${errTag(err)}`);
        return { ok: false, reason: 'error' };
      }
    },

    interrupt(guildId, reason = 'interrupted') {
      try {
        return ctx.speakers.get(idOf(guildId))?.interrupt(reason) ?? false;
      } catch (err) {
        warn(`[TTS] Falha ao interromper (servidor ${safeTag(guildId)}): ${errTag(err)}`);
        return false;
      }
    },

    dispose(guildId, reason = 'disposed') {
      try {
        return ctx.speakers.get(idOf(guildId))?.dispose(reason) ?? false;
      } catch (err) {
        warn(`[TTS] Falha ao descartar (servidor ${safeTag(guildId)}): ${errTag(err)}`);
        return false;
      }
    },

    disposeAll(reason = 'shutdown') {
      let count = 0;
      ctx.preSpeaking.clear();
      for (const speaker of [...ctx.speakers.values()]) {
        try {
          if (speaker.dispose(reason)) count += 1;
        } catch (err) {
          warn(`[TTS] Falha ao descartar (servidor ${safeTag(speaker.guildId)}): ${errTag(err)}`);
        }
      }
      return count;
    },

    isSpeaking(guildId) {
      try {
        return !!ctx.speakers.get(idOf(guildId))?.current;
      } catch {
        return false;
      }
    },

    overlapsSpeech(guildId, startMs, endMs) {
      try {
        return ctx.speakers.get(idOf(guildId))?.overlapsSpeech(startMs, endMs) ?? false;
      } catch {
        return false;
      }
    },

    noteHumanSpeaking(guildId, userId, speaking) {
      try {
        const gid = idOf(guildId);
        const speaker = ctx.speakers.get(gid);
        if (speaker) speaker.noteHuman(userId, !!speaking);
        else if (gid) notePreSpeaking(gid, userId, !!speaking);
      } catch (err) {
        warn(`[TTS] Falha ao registrar fala humana (servidor ${safeTag(guildId)}): ${errTag(err)}`);
      }
    },

    /**
     * Aquece o codificador Opus codificando um trecho de silêncio. A partida a frio (inicialização do
     * opusscript) parava o laço de eventos por 100 a 270 ms na 1ª fala; feita ao entrar na call, essa
     * parada acontece antes de a Yui ter algo a dizer. Nunca rejeita; devolve true se aqueceu.
     */
    warmup() {
      warming ??= (async () => {
        let readable = null;
        let resource = null;
        let timer = null;
        try {
          readable = await ctx.readableFromPcm(Buffer.alloc(LIMITS.frameBytes * 10));
          resource = ctx.createResource(readable, { inputType: ctx.lib.StreamType.Raw });
          const stream = resource?.playStream;
          if (!stream || typeof stream.on !== 'function') return false;
          await new Promise((resolve) => {
            stream.on('data', NOOP); // só consumir: o que importa é o codificador rodar
            stream.once('end', resolve);
            stream.once('close', resolve);
            stream.once('error', resolve);
            timer = unref(ctx.timers.setTimeout(resolve, 3_000)); // rede de segurança
          });
          return true;
        } catch {
          return false;
        } finally {
          if (timer !== null) { try { ctx.timers.clearTimeout(timer); } catch { /* ignora */ } }
          destroyQuietly(resource?.playStream);
          destroyQuietly(readable);
        }
      })().then((ok) => {
        if (!ok) warming = null; // falhou: a próxima chamada tenta de novo
        return ok;
      });
      return warming;
    },

    getStatus() {
      const guilds = [...ctx.speakers.values()].map((s) => s.status());
      return { guilds, count: guilds.length };
    },
  };
}
