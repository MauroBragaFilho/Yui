/**
 * Provedor FALSO de TTS: serve aos testes e ao modo `--fake` (sem voz de verdade,
 * sem processo, sem rede). Devolve uma senoide mono cuja duração é proporcional ao
 * tamanho do texto, então dá para testar fila, prefetch, timeouts e interrupção
 * sem ouvir nada.
 *
 * Modos:
 *  - 'ok'    devolve o áudio (depois de `delayMs`, se houver);
 *  - 'fail'  rejeita com código FAKE_FAILURE (provedor quebrado);
 *  - 'slow'  espera `delayMs` (5000 se não informado) e então devolve o áudio:
 *            serve para provar timeout e abort;
 *  - 'empty' devolve PCM vazio (o motor deve tratar como falha).
 *
 * Cumpre o contrato de provedor do T1 §3.4. Extras só para teste: `stats` (quantas
 * vezes cada método foi chamado; nunca guarda o texto) e `setMode()`.
 */

/** Milissegundos de áudio por caractere (aprox. a velocidade de uma voz de verdade). */
const MS_PER_CHAR = 60;
const MIN_MS = 200;
const MAX_MS = 8000;

/** Duração do áudio falso para um texto (útil para os testes calcularem o esperado). */
export function fakeDurationMs(text) {
  const len = String(text ?? '').length;
  return Math.min(MAX_MS, Math.max(MIN_MS, len * MS_PER_CHAR));
}

function abortedError() {
  const err = new Error('síntese abortada');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

/** Senoide de 220 Hz com um harmônico, volume moderado (o normalizador acerta o resto). */
function makeTone(durationMs, sampleRate) {
  const n = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const v = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 440 * t);
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

/**
 * @param {object} [o]
 * @param {string} [o.name='fake']
 * @param {boolean} [o.local=true]     false simula um provedor de nuvem (porta de privacidade).
 * @param {'ok'|'fail'|'slow'|'empty'} [o.mode='ok']
 * @param {number} [o.delayMs=0]
 * @param {number} [o.sampleRate=24000]
 * @param {boolean} [o.probeOk=true]
 * @param {{setTimeout: function, clearTimeout: function}} [o.timers]  relógio falso dos testes.
 */
export function createFakeProvider({
  name = 'fake',
  local = true,
  mode = 'ok',
  delayMs = 0,
  sampleRate = 24000,
  probeOk = true,
  timers = { setTimeout, clearTimeout },
} = {}) {
  let currentMode = mode;
  const stats = { probe: 0, warmup: 0, synth: 0, dispose: 0 };

  /** Espera `ms` respeitando o signal; rejeita com ABORTED se for abortado. */
  function wait(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        if (timer !== null) timers.clearTimeout(timer);
        reject(abortedError());
      };
      timer = timers.setTimeout(() => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      }, ms);
      timer?.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  return {
    name,
    local,
    stats,
    setMode(next) {
      currentMode = next;
    },

    async probe() {
      stats.probe++;
      return { ok: Boolean(probeOk), detail: `fake (${currentMode})` };
    },

    async warmup() {
      stats.warmup++;
    },

    async synth(text, { signal } = {}) {
      stats.synth++;
      if (signal?.aborted) throw abortedError();

      if (currentMode === 'fail') {
        const err = new Error('falha simulada');
        err.code = 'FAKE_FAILURE';
        throw err;
      }
      if (currentMode === 'slow') await wait(delayMs > 0 ? delayMs : 5000, signal);
      else if (delayMs > 0) await wait(delayMs, signal);
      if (signal?.aborted) throw abortedError();

      if (currentMode === 'empty') return { pcm: Buffer.alloc(0), sampleRate, channels: 1 };
      return { pcm: makeTone(fakeDurationMs(text), sampleRate), sampleRate, channels: 1 };
    },

    async dispose() {
      stats.dispose++;
    },
  };
}
