/**
 * Provedor EDGE (voz neural da Microsoft, NUVEM) para o TTS da Yui.
 *
 * Por que existe: a voz do Windows (SAPI) é robótica; as vozes neurais pt-BR (Francisca, Thalita, Antonio)
 * soam bem mais naturais e a síntese sai do PC (não gasta CPU/GPU com jogo aberto).
 * Custo da escolha: o TEXTO FALADO sai para a Microsoft. Por isso este provedor tem `local: false`:
 * o motor só o chama com `YUI_TTS_CLOUD=true` e texto NÃO sensível (porta de privacidade do engine.js).
 * O acesso é o da leitura em voz alta do Edge (biblioteca msedge-tts, não oficial): pode mudar ou
 * bloquear sem aviso; o disjuntor do motor cai para o SAPI nesse caso.
 *
 * Fluxo: texto -> escape XML -> WebSocket do Edge (MP3 24 kHz mono) -> ffmpeg (execFile/spawn com array,
 * ambiente mínimo) -> PCM s16le 24 kHz mono (o audio.js do TTS converte para 48 kHz estéreo).
 * Limites: texto <= 600 caracteres, MP3 <= 2 MB, PCM <= 20 MB, teto diário de caracteres.
 * Erros só com `code` (EDGE_*, ABORTED): nunca o texto falado nem a mensagem crua da biblioteca.
 * Sem efeito colateral ao importar: nada é carregado nem aberto até probe()/synth().
 */
import { spawn as nodeSpawn } from 'node:child_process';

const SAMPLE_RATE = 24000;
const MAX_TEXT_CHARS = 600;
const MAX_MP3_BYTES = 2 * 1024 * 1024;
const MAX_PCM_BYTES = 20 * 1024 * 1024;

function failure(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function abortedError() {
  const err = new Error('síntese abortada');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

/** Texto para dentro do SSML: sem controles e com os 5 caracteres especiais do XML escapados. */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Valida valores de prosódia vindos do .env (nunca entram no SSML sem passar por aqui). */
export function safeProsody(value, fallback) {
  const v = String(value ?? '').trim();
  return /^[+-]?\d{1,3}(?:\.\d{1,2})?(?:%|Hz|st)$/.test(v) ? v : fallback;
}

export function safeVoice(value, fallback) {
  const v = String(value ?? '').trim();
  return /^[a-z]{2}-[A-Z]{2}-[A-Za-z]{2,30}Neural$/.test(v) ? v : fallback;
}

/**
 * @param {object} [o]
 * @param {object} [o.config]       getTtsConfig() (edgeVoice, edgeRate, edgePitch, edgeMaxCharsPerDay)
 * @param {object} [o.logger]
 * @param {() => number} [o.now]
 * @param {() => Promise<{MsEdgeTTS: any, OUTPUT_FORMAT: any}>} [o.loadClient]  injetável (testes)
 * @param {function} [o.spawn]      injetável (testes): spawn(file, args, opts)
 * @param {() => (string|Promise<string>)} [o.getFfmpeg]  caminho do ffmpeg (injetável)
 */
export function createEdgeProvider({ config = {}, logger = null, now = Date.now, loadClient = null, spawn = nodeSpawn, getFfmpeg = null } = {}) {
  const log = (level, msg) => { try { logger?.[level]?.(msg); } catch { /* log nunca derruba */ } };
  const voice = safeVoice(config.edgeVoice, 'pt-BR-FranciscaNeural');
  const rate = safeProsody(config.edgeRate, '-4%');
  const pitch = safeProsody(config.edgePitch, '+0Hz');
  const maxPerDay = Number.isFinite(config.edgeMaxCharsPerDay) ? config.edgeMaxCharsPerDay : 100_000;
  let usage = { day: '', chars: 0 };

  const loadLib = loadClient || (async () => {
    const raw = await import('msedge-tts');
    const mod = raw.MsEdgeTTS ? raw : (raw.default ?? raw); // pacote CommonJS: os exports podem vir em `default`
    if (typeof mod.MsEdgeTTS !== 'function') throw failure('EDGE_LIB', 'biblioteca msedge-tts inválida');
    return { MsEdgeTTS: mod.MsEdgeTTS, OUTPUT_FORMAT: mod.OUTPUT_FORMAT };
  });
  const ffmpegPath = async () => {
    if (getFfmpeg) return await getFfmpeg();
    const { getFfmpegPath } = await import('../../../utils/binaries.js');
    return getFfmpegPath();
  };

  function takeQuota(chars) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (usage.day !== day) usage = { day, chars: 0 };
    if (usage.chars + chars > maxPerDay) throw failure('EDGE_QUOTA', 'teto diário de caracteres da voz na nuvem');
    usage.chars += chars;
  }

  /** Baixa o MP3 (WebSocket do Edge), com abort e limite de bytes. */
  async function fetchMp3(text, signal) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await loadLib();
    const tts = new MsEdgeTTS();
    let settled = false;
    let stream = null;
    const cleanup = () => {
      try { stream?.destroy?.(); } catch { /* ok */ }
      try { tts.close?.(); } catch { /* ok */ }
    };
    return await new Promise((resolve, reject) => {
      const done = (fn, v) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); cleanup(); fn(v); };
      const onAbort = () => done(reject, abortedError());
      if (signal?.aborted) return done(reject, abortedError());
      signal?.addEventListener?.('abort', onAbort, { once: true });
      (async () => {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        const out = tts.toStream(escapeXml(text), { rate, pitch });
        stream = out.audioStream;
        const chunks = [];
        let bytes = 0;
        stream.on('data', (d) => {
          bytes += d.length;
          if (bytes > MAX_MP3_BYTES) return done(reject, failure('EDGE_TOO_BIG', 'áudio grande demais'));
          chunks.push(Buffer.from(d));
        });
        stream.on('error', () => done(reject, failure('EDGE_ERROR', 'falha na voz da nuvem')));
        const finish = () => (bytes > 0 ? done(resolve, Buffer.concat(chunks)) : done(reject, failure('EDGE_EMPTY', 'a voz da nuvem não devolveu áudio')));
        stream.on('end', finish);
        stream.on('close', finish);
      })().catch(() => done(reject, failure('EDGE_ERROR', 'falha na voz da nuvem')));
    });
  }

  /** MP3 -> PCM s16le 24 kHz mono, com o ffmpeg (ambiente mínimo, sem shell). */
  async function toPcm(mp3, signal) {
    const exe = await ffmpegPath();
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortedError());
      const child = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : '' },
      });
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); fn(v); };
      const onAbort = () => { try { child.kill(); } catch { /* ok */ } done(reject, abortedError()); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      child.stdout.on('data', (d) => {
        bytes += d.length;
        if (bytes > MAX_PCM_BYTES) { try { child.kill(); } catch { /* ok */ } return done(reject, failure('EDGE_FFMPEG', 'conversão grande demais')); }
        chunks.push(d);
      });
      child.on('error', () => done(reject, failure('EDGE_FFMPEG', 'ffmpeg indisponível')));
      child.on('close', (code) => (code === 0 && bytes > 0 ? done(resolve, Buffer.concat(chunks)) : done(reject, failure('EDGE_FFMPEG', 'falha ao converter o áudio'))));
      child.stdin.on('error', () => { /* o close trata */ });
      child.stdin.end(mp3);
    });
  }

  return {
    name: 'edge',
    local: false,

    /** Sem rede: confere só que a biblioteca e o ffmpeg existem. */
    async probe() {
      try {
        await loadLib();
        const exe = await ffmpegPath();
        return exe ? { ok: true, detail: `voz neural ${voice} (nuvem; a rede só é usada na 1ª fala)` } : { ok: false, detail: 'ffmpeg não encontrado' };
      } catch {
        return { ok: false, detail: 'biblioteca msedge-tts ausente (npm install)' };
      }
    },

    async warmup() { /* nada residente */ },

    async synth(text, { signal } = {}) {
      const clean = String(text ?? '').trim();
      if (!clean) throw failure('EDGE_EMPTY', 'texto vazio');
      if (clean.length > MAX_TEXT_CHARS) throw failure('EDGE_TOO_LONG', 'texto longo demais para uma frase');
      takeQuota(clean.length);
      const t0 = now();
      const mp3 = await fetchMp3(clean, signal);
      const pcm = await toPcm(mp3, signal);
      log('info', `[TTS] Edge: ${clean.length} caracteres -> ${pcm.length} bytes de PCM em ${now() - t0} ms`);
      return { pcm, sampleRate: SAMPLE_RATE, channels: 1 };
    },

    async dispose() { /* nada residente */ },

    /** Só para teste/status: caracteres usados hoje (nunca o texto). */
    getUsage: () => ({ ...usage, maxPerDay }),
  };
}
