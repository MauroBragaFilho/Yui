/**
 * Robustez da voz (call de IA e Modo Rádio).
 *
 * Contexto: o evento `speaking.start` do @discordjs/voice é emitido a cada pacote
 * de um usuário que ainda não está "falando" (SpeakingMap.onPacket emite ANTES de
 * armar o timeout). Se o ouvinte lançar, TODO novo pacote (~50/s) reemite o evento
 * e a exceção sobe como `uncaughtException` ("Erro grave") ou, em ouvinte async,
 * como `unhandledRejection`. Aqui fica a lógica que impede isso:
 *
 *  - guarda por usuário (um fio por pessoa) com backoff após falha;
 *  - ouvinte que NUNCA propaga exceção, registra a falha UMA vez e desliga a escuta
 *    da sessão depois de N falhas seguidas;
 *  - ouvintes de 'error' em streams, conexões e players;
 *  - disjuntor para faixas do rádio que falham em sequência.
 *
 * Este módulo é puro: não abre banco, não cria pastas, não inicia timers sem
 * `unref` e recebe logger/relógio/streams por injeção (por isso é testável sem
 * Discord e sem rede). Não registra conteúdo de fala nem de transcrição.
 */

export const VOICE_DEFAULTS = Object.freeze({
  /** Tempo em que um usuário que falhou fica ignorado. */
  failBackoffMs: 60_000,
  /** Falhas seguidas (sem nenhum sucesso entre elas) que desligam a escuta da sessão. */
  maxConsecutiveFailures: 5,
  /**
   * Teto de duração de uma fala (decisão D7 / TG-35): trechos acima de 30 s são ENCERRADOS. Passado o teto a captura é
   * fechada e só o que veio até ali (os primeiros 30 s) segue para a transcrição; o resto não é guardado. Antes eram 120 s,
   * ou seja, um WAV de cerca de 22 MB (48 kHz, estéreo, 16 bits) que provavelmente vários provedores de STT recusam; com 30 s
   * o WAV tem cerca de 5,5 MB. Vale para a call de IA e para os comandos de voz do Modo Rádio.
   */
  maxStreamMs: 30_000,
  /** Teto da transcrição (caracteres) que segue ao pipeline; o excedente é descartado (veja clampTranscript). */
  maxTranscriptChars: 1500,
});

/** Mensagem amigável quando falta o codificador Opus (voz/rádio indisponíveis). */
export const VOICE_UNAVAILABLE_MESSAGE =
  '⚠️ A voz e o Modo Rádio estão indisponíveis no momento: faltam componentes de áudio no servidor da Yui (codificador Opus). Avise o dono para verificar.';

/** Primeira linha (curta) de um erro, sem pilha nem caminhos longos. */
export function errMsg(err) {
  const text = String(err?.message ?? err ?? 'erro desconhecido');
  const line = text.split(/\r?\n/).find((l) => l.trim()) || 'erro desconhecido';
  return line.trim().slice(0, 200);
}

/**
 * Corta a transcrição do STT em `max` caracteres (padrão 1500, decisão D7 / TG-35) antes de ela seguir ao pipeline. Só o FIM é
 * descartado, então a palavra de ativação (que abre a frase) e o início do pedido ficam. Nunca deixa meio par substituto (emoji)
 * e prefere terminar numa fronteira de palavra se ela estiver nos últimos 10% do trecho. Aceita qualquer coisa: o que não é texto
 * vira ''. Em fala real (limite de 30 s, cerca de 15 caracteres por segundo) o corte só pega saída de STT fora do normal
 * (alucinação repetida, por exemplo).
 */
export function clampTranscript(text, max = VOICE_DEFAULTS.maxTranscriptChars) {
  if (typeof text !== 'string') return '';
  const limit = Math.floor(Number(max));
  if (!(limit > 0)) return '';
  if (text.length <= limit) return text;
  let cut = limit;
  const lastUnit = text.charCodeAt(cut - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cut -= 1; // o par substituto continuaria depois do corte
  const floor = Math.floor(cut * 0.9);
  for (let i = cut; i > floor; i--) {
    if (/\s/.test(text[i])) { cut = i; break; }
  }
  return text.slice(0, cut).trimEnd();
}

// ── Guarda por usuário ────────────────────────────────────────────────

/**
 * Controla quais usuários estão com captura ativa, quais estão em backoff por
 * falha e quantas falhas seguidas a sessão acumulou.
 */
export function createSpeakerGuard({
  now = () => Date.now(),
  backoffMs = VOICE_DEFAULTS.failBackoffMs,
  maxConsecutiveFailures = VOICE_DEFAULTS.maxConsecutiveFailures,
} = {}) {
  const active = new Set();
  const failedUntil = new Map(); // chave -> quando o backoff acaba
  const throttled = new Map(); // etiqueta -> próximo log permitido
  let consecutive = 0;
  let disabled = false;

  const prune = () => {
    const t = now();
    for (const [k, until] of failedUntil) if (until <= t) failedUntil.delete(k);
    for (const [k, until] of throttled) if (until <= t) throttled.delete(k);
  };

  return {
    /** @returns {'ok'|'busy'|'backoff'|'disabled'} 'ok' = a chave passou a ser nossa. */
    tryStart(key) {
      if (disabled) return 'disabled';
      if (active.has(key)) return 'busy';
      const until = failedUntil.get(key);
      if (until !== undefined) {
        if (now() < until) return 'backoff';
        failedUntil.delete(key);
      }
      active.add(key);
      return 'ok';
    },
    /** Libera a chave sem contar sucesso nem falha (ex.: usuário ignorado). */
    release(key) {
      active.delete(key);
    },
    /** Captura terminou bem: libera e zera a contagem de falhas seguidas. */
    success(key) {
      active.delete(key);
      consecutive = 0;
    },
    /**
     * Captura falhou: libera a chave, aplica backoff e soma uma falha seguida.
     * @returns {{ consecutive: number, tripped: boolean }} tripped = true só na vez em que a sessão foi desligada.
     */
    fail(key) {
      active.delete(key);
      failedUntil.set(key, now() + backoffMs);
      if (failedUntil.size > 200) prune();
      consecutive += 1;
      let tripped = false;
      if (!disabled && consecutive >= maxConsecutiveFailures) {
        disabled = true;
        tripped = true;
      }
      return { consecutive, tripped };
    },
    /** true no máximo uma vez por `ms` para a mesma etiqueta (evita log a cada pacote). */
    shouldLog(tag, ms = 60_000) {
      const t = now();
      const until = throttled.get(tag);
      if (until !== undefined && t < until) return false;
      throttled.set(tag, t + ms);
      if (throttled.size > 200) prune();
      return true;
    },
    isDisabled: () => disabled,
    isActive: (key) => active.has(key),
    failedUntil: (key) => failedUntil.get(key) ?? 0,
    consecutiveFailures: () => consecutive,
    backoffMs,
    maxConsecutiveFailures,
    reset() {
      active.clear();
      failedUntil.clear();
      throttled.clear();
      consecutive = 0;
      disabled = false;
    },
  };
}

// ── Ouvinte de 'speaking.start' ───────────────────────────────────────

/**
 * Cria o ouvinte de `speaking.start`. O ouvinte devolvido é síncrono e nunca
 * lança; todo o trabalho (checagens, assinatura, decodificação, processamento
 * do áudio) roda dentro de try/catch.
 *
 * @param {object}   o
 * @param {string}   o.label          Prefixo do log ('VOICE', 'RadioVoice').
 * @param {string}   o.guildId
 * @param {object}   o.guard          Resultado de createSpeakerGuard().
 * @param {object}   o.log            { info, warn, error } (logger do projeto).
 * @param {function} o.createDecoder  () => stream Transform que decodifica Opus -> PCM.
 * @param {function} o.subscribe      (userId) => stream Opus do usuário (receiver.subscribe).
 * @param {function} [o.precheck]     (userId) => boolean | Promise<boolean>; false = ignorar essa fala.
 * @param {function} o.onAudio        async (userId, pcmBuffer) => void; erros são só registrados.
 * @param {function} [o.onTrip]       ({ consecutive, lastError }) => void; chamado UMA vez ao desligar a escuta.
 * @param {number}   [o.maxStreamMs]  Teto de duração de uma fala (padrão VOICE_DEFAULTS.maxStreamMs = 30 s): passado disso a captura é
 *                                    encerrada e só o trecho captado até ali é processado.
 */
export function createSpeakingListener({
  label,
  guildId,
  guard,
  log,
  createDecoder,
  subscribe,
  precheck = () => true,
  onAudio,
  onTrip = null,
  maxStreamMs = VOICE_DEFAULTS.maxStreamMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const quiet = (fn) => {
    try { return fn(); } catch { return undefined; }
  };

  function failKey(key, userId, err) {
    const verdict = guard.fail(key);
    quiet(() => log.warn(
      `[${label}] Falha ao captar a voz (servidor ${guildId}, usuário ${userId}): ${errMsg(err)}. ` +
      `Usuário ignorado por ${Math.round(guard.backoffMs / 1000)}s (${verdict.consecutive}/${guard.maxConsecutiveFailures} falhas seguidas).`
    ));
    if (verdict.tripped) {
      quiet(() => log.error(
        `[${label}] Escuta de voz DESLIGADA nesta sessão (servidor ${guildId}) após ${verdict.consecutive} falhas seguidas. ` +
        `Última causa: ${errMsg(err)}. Entre de novo na call/rádio para tentar novamente.`
      ));
      quiet(() => onTrip?.({ consecutive: verdict.consecutive, lastError: errMsg(err) }));
    }
  }

  async function capture(userId, key) {
    let opusStream = null;
    let decoder = null;
    let timer = null;
    let settled = false;
    const chunks = [];

    const destroyStreams = () => {
      quiet(() => opusStream?.unpipe?.(decoder));
      quiet(() => opusStream?.destroy?.());
      quiet(() => decoder?.destroy?.());
    };
    const stopTimer = () => {
      if (timer) quiet(() => clearTimeoutImpl(timer));
      timer = null;
    };
    const settleFail = (err) => {
      if (settled) return;
      settled = true;
      stopTimer();
      destroyStreams();
      failKey(key, userId, err);
    };

    try {
      const proceed = await precheck(userId);
      if (!proceed) {
        settled = true;
        guard.release(key);
        return;
      }

      // Decoder primeiro: se faltar o Opus, falha aqui sem deixar assinatura pendurada.
      decoder = createDecoder();
      opusStream = subscribe(userId);

      // Ouvintes de erro ANTES de ligar o pipe (sem eles, 'error' vira Uncaught Exception).
      opusStream.on('error', settleFail);
      decoder.on('error', settleFail);
      decoder.on('data', (chunk) => { chunks.push(chunk); });
      decoder.on('end', () => {
        if (settled) return;
        settled = true;
        stopTimer();
        guard.success(key);
        Promise.resolve()
          .then(() => onAudio(userId, Buffer.concat(chunks)))
          .catch((err) => quiet(() => log.warn(
            `[${label}] Falha ao processar o áudio (servidor ${guildId}, usuário ${userId}): ${errMsg(err)}`
          )));
      });
      // Decoder fechado sem 'end' nem 'error': libera a chave para não ficar presa.
      decoder.on('close', () => {
        if (settled) return;
        settled = true;
        stopTimer();
        guard.release(key);
      });

      opusStream.pipe(decoder);
      // Fonte fechada sem 'end' (assinatura derrubada): pipe não encerra o destino sozinho; fecha para processar o que veio.
      opusStream.on('close', () => {
        if (!settled) quiet(() => decoder.end());
      });

      timer = setTimeoutImpl(() => {
        timer = null;
        if (settled) return;
        quiet(() => log.warn(
          `[${label}] Fala acima de ${Math.round(maxStreamMs / 1000)}s (servidor ${guildId}, usuário ${userId}): encerrando a captura; só o trecho captado até aqui segue para a transcrição.`
        ));
        quiet(() => opusStream.unpipe(decoder));
        quiet(() => opusStream.destroy());
        quiet(() => decoder.end());
      }, maxStreamMs);
      quiet(() => timer?.unref?.());
    } catch (err) {
      settleFail(err);
    }
  }

  return function onSpeakingStart(userId) {
    try {
      const key = `${guildId}_${userId}`;
      if (guard.tryStart(key) !== 'ok') return;
      capture(userId, key).catch((err) => {
        // capture() já trata tudo; isto é só uma rede de segurança.
        guard.release(key);
        quiet(() => log.warn(`[${label}] Erro inesperado na captura de voz (servidor ${guildId}): ${errMsg(err)}`));
      });
    } catch (err) {
      quiet(() => log.warn(`[${label}] Erro no ouvinte de voz (servidor ${guildId}): ${errMsg(err)}`));
    }
  };
}

/**
 * Liga o ouvinte ao `receiver.speaking`. Ao desligar a escuta (falhas demais)
 * o ouvinte é removido do receiver.
 * @returns {{ listener: function, guard: object, detach: function }}
 */
export function attachSpeakingListener(receiver, options) {
  const guard = options.guard || createSpeakerGuard(options.guardOptions);
  let detach = () => {};
  const listener = createSpeakingListener({
    ...options,
    guard,
    onTrip: (info) => {
      detach();
      try { options.onTrip?.(info); } catch { /* nunca propaga */ }
    },
  });
  const emitter = receiver.speaking;
  emitter.on('start', listener);
  detach = () => {
    try { emitter.off?.('start', listener) ?? emitter.removeListener?.('start', listener); } catch { /* ignora */ }
  };
  return { listener, guard, detach };
}

// ── 'error' em conexões e players ─────────────────────────────────────

/**
 * `VoiceConnection.onNetworkingError` emite 'error'; sem ouvinte isso vira
 * uncaughtException. Só registra (a máquina de estados já cuida da reconexão).
 */
export function attachConnectionSafety(connection, { label, guildId, log }) {
  const handler = (err) => {
    try { log.warn(`[${label}] Erro na conexão de voz (servidor ${guildId}): ${errMsg(err)}`); } catch { /* ignora */ }
  };
  connection.on('error', handler);
  return handler;
}

/** Todo AudioPlayer precisa de um ouvinte de 'error'. */
export function attachPlayerSafety(player, { label, guildId, log }) {
  const handler = (err) => {
    try { log.warn(`[${label}] Erro no player de áudio (servidor ${guildId}): ${errMsg(err)}`); } catch { /* ignora */ }
  };
  player.on('error', handler);
  return handler;
}

// ── Disjuntor do rádio ────────────────────────────────────────────────

/**
 * Distingue "ambiente quebrado" (sem Opus/ffmpeg/criptografia) de "faixa que não
 * toca" (não encontrada, bloqueada, yt-dlp falhou). Erros explícitos podem trazer
 * `err.kind`.
 * @returns {'environment'|'track'}
 */
export function classifyPlaybackError(err) {
  if (err?.kind === 'environment' || err?.kind === 'track') return err.kind;
  const text = `${err?.code ?? ''} ${err?.message ?? err ?? ''}`;
  // Codec/criptografia ausentes ou binário que nem abre: nada vai tocar até alguém consertar.
  if (/\bopus\b|opusscript|sodium|no valid encryption|@noble\/ciphers|Cannot find module/i.test(text)) return 'environment';
  if (err?.code === 'ENOENT' && /spawn/i.test(text)) return 'environment';
  return 'track';
}

/** Erro de ambiente com mensagem amigável já pronta para o usuário. */
export function environmentError(message) {
  const err = new Error(message);
  err.kind = 'environment';
  return err;
}

/** Limites (ms de áudio realmente tocado) para julgar o fim de uma faixa do rádio. */
export const IDLE_DEFAULTS = Object.freeze({
  /** Tocou pelo menos isto sem erro: a faixa "funcionou" e zera as falhas seguidas. */
  successMs: 3000,
  /** Tocou menos que isto e terminou sem erro: faixa vazia (yt-dlp/ffmpeg sem dados), conta como falha. */
  emptyMs: 1000,
});

/**
 * O que um evento Idle do AudioPlayer significa para o rádio.
 *
 *  - 'ignore'  : não é o fim natural da faixa atual (parada forçada nossa, troca de faixa, chime): não faz nada.
 *  - 'failure' : a faixa atual terminou SEM erro e SEM áudio (menos de `emptyMs`): é uma faixa vazia, conta como falha.
 *  - 'success' : a faixa atual tocou pelo menos `successMs` sem erro.
 *  - 'neutral' : fim natural que não é nem falha nem sucesso claro (ou que já teve o erro tratado pelo ouvinte de 'error').
 *
 * Sem este julgamento uma faixa vazia (Modo Rápido com yt-dlp quebrado: ffmpeg com 0 bytes) ia a Idle quase
 * na hora, ficava sem contar falha nem sucesso e, dentro da janela de transição, nem fazia o rádio avançar.
 *
 * @param {object} o
 * @param {object} o.oldState   Estado anterior do player (o 1º argumento do evento Idle).
 * @param {boolean} o.isCurrent O recurso que terminou é o da faixa atual (não foi trocado/parado por nós)?
 * @param {boolean} o.errored   O player acabou de emitir 'error' para essa faixa (o disjuntor já contou)?
 */
export function classifyIdleEnd({ oldState, isCurrent, errored = false, successMs = IDLE_DEFAULTS.successMs, emptyMs = IDLE_DEFAULTS.emptyMs }) {
  if (!isCurrent) return 'ignore';
  if (errored) return 'neutral';
  const status = oldState?.status;
  // Só Buffering (acabou antes de ficar legível) e Playing são fins naturais; o resto mantém o comportamento antigo.
  if (status !== 'playing' && status !== 'buffering') return 'neutral';
  const playedMs = Number(oldState?.resource?.playbackDuration ?? 0) || 0;
  if (playedMs < emptyMs) return 'failure';
  if (status === 'playing' && playedMs >= successMs) return 'success';
  return 'neutral';
}

/**
 * Conta falhas consecutivas por servidor. Ambiente quebrado dispara mais cedo
 * (todas as faixas falhariam do mesmo jeito); faixa que não toca tolera mais.
 */
export function createFailureBreaker({ maxEnvironment = 2, maxTrack = 5 } = {}) {
  const state = new Map(); // guildId -> { count, kind }
  return {
    /** @returns {{ count: number, kind: 'environment'|'track', trip: boolean }} */
    recordFailure(guildId, kind = 'track') {
      const prev = state.get(guildId) || { count: 0, kind };
      // Uma falha de ambiente "contamina" a sequência (é a causa mais grave).
      const merged = prev.kind === 'environment' || kind === 'environment' ? 'environment' : 'track';
      const entry = { count: prev.count + 1, kind: merged };
      state.set(guildId, entry);
      const limit = merged === 'environment' ? maxEnvironment : maxTrack;
      return { count: entry.count, kind: merged, trip: entry.count >= limit };
    },
    recordSuccess(guildId) {
      state.delete(guildId);
    },
    reset(guildId) {
      state.delete(guildId);
    },
    count(guildId) {
      return state.get(guildId)?.count ?? 0;
    },
  };
}
