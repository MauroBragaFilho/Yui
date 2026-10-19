/**
 * Áudio do TTS: tudo em JS puro e em memória (nenhum arquivo, nenhum processo).
 *
 * O Discord toca PCM s16le estéreo a 48 kHz em quadros de 20 ms (3840 bytes). Os
 * provedores entregam outras coisas (SAPI: PCM cru 48 kHz; fake: mono 24 kHz;
 * Piper no futuro: WAV 22,05 kHz). Este módulo leva qualquer uma delas ao formato
 * do Discord, com volume parecido entre provedores e sem estalos nas pontas.
 *
 *  - parseWav():       lê WAV tolerante (cabeçalhos estranhos, streaming do ffmpeg).
 *  - toDiscordPcm():   mono->estéreo, resample linear, apara silêncio inicial,
 *                      fade, normaliza o pico, cauda de silêncio, múltiplo de 3840.
 *  - pcmToReadable():  alimenta o codificador Opus em pedaços pequenos, com
 *                      backpressure, para não travar o laço de eventos.
 *  - pcmDurationMs():  duração de um PCM no formato do Discord.
 *
 * Sem efeito colateral ao importar. Não registra nada em log (não há dado de
 * usuário aqui) e os erros próprios só carregam `code`.
 */

import { Readable } from 'node:stream';

/** 20 ms de áudio estéreo a 48 kHz em s16le: 960 amostras x 2 canais x 2 bytes. */
export const DISCORD_FRAME_BYTES = 3840;
export const DISCORD_SAMPLE_RATE = 48000;
export const DISCORD_CHANNELS = 2;

const FRAME_SAMPLES = DISCORD_FRAME_BYTES / (DISCORD_CHANNELS * 2); // 960 por canal

// Ajustes de acabamento (explicados em toDiscordPcm).
const LEAD_KEEP_MS = 30;
const TRAIL_KEEP_MS = 20;
const FADE_MS = 5;
const TAIL_MS = 60;
const PEAK_TARGET = 0.85;
const GAIN_MIN = 0.5;
const GAIN_MAX = 10 ** (12 / 20); // +12 dB
const SILENCE_FLOOR = 0.002; // ~ -54 dBFS: abaixo disso é "nada"
const SILENCE_CEIL = 0.01; // ~ -40 dBFS: acima disso já é som

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function audioError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// ── Leitura de amostras ───────────────────────────────────────────────

/** Int16Array com as amostras s16le do buffer (sem copiar quando dá). */
function readInt16Samples(buf) {
  const n = buf.length >> 1;
  if (LITTLE_ENDIAN && buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, n);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Converte float32 little-endian (-1..1) em um Buffer s16le. */
function float32ToS16(buf) {
  const n = buf.length >> 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = buf.readFloatLE(i * 4);
    // NaN/Infinito de um WAV corrompido viram silêncio em vez de estourar.
    const c = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(c * 32768)));
  }
  return int16ToBuffer(out);
}

function int16ToBuffer(i16) {
  const buf = Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
  if (!LITTLE_ENDIAN) buf.swap16(); // o formato do Discord é sempre little-endian
  return buf;
}

// ── WAV ───────────────────────────────────────────────────────────────

/**
 * Lê um WAV e devolve o PCM s16le intercalado.
 *
 * Tolerâncias (cada uma existe porque já apareceu de verdade):
 *  - chunks quaisquer antes do `data` (LIST, fact, JUNK...); o ffmpeg põe o `data`
 *    no offset 78, então NÃO dá para assumir cabeçalho de 44 bytes;
 *  - `data` com tamanho 0 ou 0xFFFFFFFF (WAV em streaming): usa o resto do buffer;
 *  - PCM de 16 bits e float32 (inclusive no formato WAVE_FORMAT_EXTENSIBLE).
 *
 * @param {Buffer} buf
 * @returns {{ pcm: Buffer, sampleRate: number, channels: number }}
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw audioError('WAV_INVALID', 'WAV curto demais');
  const magic = buf.toString('latin1', 0, 4);
  if ((magic !== 'RIFF' && magic !== 'RF64') || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw audioError('WAV_INVALID', 'cabeçalho RIFF/WAVE ausente');
  }

  let fmt = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw audioError('WAV_INVALID', 'chunk fmt truncado');
      let format = buf.readUInt16LE(body);
      // Extensible: o código real do formato está no começo do GUID do subformato.
      if (format === 0xfffe && size >= 40 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24);
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw audioError('WAV_INVALID', 'data antes de fmt');
      // Tamanho 0 / 0xFFFFFFFF / maior que o arquivo = streaming: vale o resto do buffer.
      const streaming = size === 0 || size === 0xffffffff || body + size > buf.length;
      return decodeWavData(buf.subarray(body, streaming ? buf.length : body + size), fmt);
    }
    // Chunks têm tamanho par: um byte de enchimento segue os de tamanho ímpar.
    offset = body + size + (size & 1);
  }
  throw audioError('WAV_INVALID', fmt ? 'chunk data ausente' : 'chunk fmt ausente');
}

function decodeWavData(data, fmt) {
  const { format, channels, sampleRate, bits } = fmt;
  if (channels < 1 || channels > 8 || sampleRate < 1) throw audioError('WAV_INVALID', 'fmt inválido');
  const isInt16 = format === 1 && bits === 16;
  const isFloat32 = format === 3 && bits === 32;
  if (!isInt16 && !isFloat32) throw audioError('WAV_UNSUPPORTED', 'só PCM de 16 bits e float32');

  // Descarta bytes que não formam um quadro completo (WAV truncado).
  const frameBytes = (bits / 8) * channels;
  const usable = data.length - (data.length % frameBytes);
  const raw = data.subarray(0, usable);
  return { pcm: isFloat32 ? float32ToS16(raw) : raw, sampleRate, channels };
}

/**
 * Monta um WAV PCM de 16 bits (cabeçalho canônico de 44 bytes). Usado por
 * scripts e testes; o bot em si nunca grava áudio em disco.
 */
export function encodeWav({ pcm, sampleRate, channels }) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── Conversão para o formato do Discord ───────────────────────────────

/** Reamostragem linear de um canal. Basta para voz; a fonte nunca passa de 48 kHz. */
function resampleLinear(x, srcRate) {
  if (srcRate === DISCORD_SAMPLE_RATE) return x;
  const outLen = Math.max(1, Math.round((x.length * DISCORD_SAMPLE_RATE) / srcRate));
  const out = new Float32Array(outLen);
  const step = srcRate / DISCORD_SAMPLE_RATE;
  const last = x.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    out[i] = x[i0] + (x[i1] - x[i0]) * (pos - i0);
  }
  return out;
}

/**
 * Leva o PCM de um provedor ao formato do Discord: s16le estéreo 48 kHz, com
 * tamanho múltiplo de 3840 bytes.
 *
 * Passos (a ordem importa):
 *  1. mono -> estéreo duplicando o canal (sem atenuar 3 dB: soaria mais baixo);
 *  2. resample linear para 48 kHz (24 kHz = fator 2 exato; 22,05 kHz = 2,177);
 *  3. apara o silêncio inicial para no máx. 30 ms (o SAPI começa com 100 a 170 ms
 *     de silêncio, o que soma ao atraso até o primeiro som) e o silêncio final
 *     (o SAPI termina com ~800 ms de zeros), deixando só 20 ms de folga;
 *  4. fade de 5 ms nas duas pontas do SINAL (evita estalo no corte);
 *  5. normaliza o pico para ~0,85 (ganho entre 0,5x e +12 dB) para os provedores
 *     terem volume parecido e nada clipar;
 *  6. cauda de 60 ms de silêncio (evita corte seco no fim e dá um respiro entre
 *     frases) e zeros até fechar o último quadro (o Encoder do prism descarta o
 *     resto menor que 3840).
 *
 * Sem som algum (vazio ou só silêncio) devolve um Buffer vazio: quem chama trata
 * como "provedor não falou". Não muda o Buffer de entrada.
 *
 * @param {{ pcm: Buffer, sampleRate: number, channels: 1|2 }} audio
 * @returns {Buffer}
 */
export function toDiscordPcm({ pcm, sampleRate, channels } = {}) {
  if (!Buffer.isBuffer(pcm)) throw audioError('AUDIO_INVALID', 'pcm precisa ser Buffer');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw audioError('AUDIO_INVALID', 'taxa de amostragem fora de 8000..192000');
  }
  if (channels !== 1 && channels !== 2) throw audioError('AUDIO_INVALID', 'só mono ou estéreo');

  const frames = Math.floor(pcm.length / (2 * channels));
  if (frames === 0) return Buffer.alloc(0);

  // 1. Separa os canais em float (-1..1).
  const i16 = readInt16Samples(pcm);
  let chans = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = i16[i * channels + c] / 32768;
    chans.push(ch);
  }

  // 2. Resample.
  chans = chans.map((ch) => resampleLinear(ch, sampleRate));
  const total = chans[0].length;
  const left = chans[0];
  const right = chans[1] || chans[0]; // mono: o mesmo canal nos dois lados

  // 3. Silêncio inicial. O limiar acompanha o volume da fala (fala baixa não
  //    pode ser confundida com silêncio, ruído de fundo não pode ser som).
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (a > peak) peak = a;
  }
  if (peak < SILENCE_FLOOR) return Buffer.alloc(0);
  const threshold = Math.max(SILENCE_FLOOR, Math.min(SILENCE_CEIL, peak * 0.05));
  let lead = 0;
  while (lead < total && Math.max(Math.abs(left[lead]), Math.abs(right[lead])) < threshold) lead++;
  const keep = Math.round((LEAD_KEEP_MS / 1000) * DISCORD_SAMPLE_RATE);
  const start = Math.max(0, lead - keep);

  // Silêncio final: o SAPI entrega ~800 ms de zeros digitais depois da última
  // palavra (medido). Sem apará-los, cada frase ganharia quase 1 s de pausa morta
  // na call. Fica só uma folga de 20 ms para a queda natural da voz.
  let lastLoud = total - 1;
  while (lastLoud > lead && Math.max(Math.abs(left[lastLoud]), Math.abs(right[lastLoud])) < threshold) lastLoud--;
  const trailKeep = Math.round((TRAIL_KEEP_MS / 1000) * DISCORD_SAMPLE_RATE);
  const end = Math.min(total, lastLoud + 1 + trailKeep);
  const n = end - start;

  // 4. Fade nas pontas do sinal (a cópia abaixo já trabalha só com o trecho útil).
  const L = left.slice(start, end);
  const R = right === left ? L : right.slice(start, end);
  const fade = Math.min(Math.round((FADE_MS / 1000) * DISCORD_SAMPLE_RATE), n >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    L[i] *= g;
    L[n - 1 - i] *= g;
    if (R !== L) {
      R[i] *= g;
      R[n - 1 - i] *= g;
    }
  }

  // 5. Ganho para o pico (já com os fades, que podem tirar o pico do lugar).
  let peakOut = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peakOut) peakOut = a;
  }
  if (peakOut <= 0) return Buffer.alloc(0);
  const gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, PEAK_TARGET / peakOut)) * 32768;

  // 6. Cauda + quadro fechado; o restante do Int16Array já nasce zerado.
  const tail = Math.round((TAIL_MS / 1000) * DISCORD_SAMPLE_RATE);
  const outFrames = Math.ceil((n + tail) / FRAME_SAMPLES);
  const out = new Int16Array(outFrames * FRAME_SAMPLES * DISCORD_CHANNELS);
  for (let i = 0; i < n; i++) {
    out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(L[i] * gain)));
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * gain)));
  }
  return int16ToBuffer(out);
}

// ── Entrega ao codificador ────────────────────────────────────────────

/**
 * Stream que entrega o PCM em pedaços de `frames` quadros (múltiplos de 3840).
 *
 * Por que não `Readable.from(buffer)`: ele emite UM chunk e o Encoder do prism
 * codificaria ~1100 quadros de uma vez no mesmo tick, travando o laço de eventos
 * (e o áudio de todo mundo na call). Com 40 quadros (~12 ms de CPU com opusscript)
 * o laço respira entre os pedaços. O `read()` só empurra um pedaço por vez, então
 * quem consome devagar não faz o buffer inteiro ser copiado para a fila interna.
 *
 * @param {Buffer} buf  PCM no formato do Discord.
 * @param {{ frames?: number }} [opts]
 * @returns {Readable}
 */
export function pcmToReadable(buf, { frames = 40 } = {}) {
  if (!Buffer.isBuffer(buf)) throw audioError('AUDIO_INVALID', 'pcm precisa ser Buffer');
  const perChunk = Math.max(1, Math.min(500, Math.floor(Number(frames)) || 40));
  const chunkBytes = perChunk * DISCORD_FRAME_BYTES;
  let offset = 0;
  return new Readable({
    highWaterMark: chunkBytes, // um pedaço de cada vez: push() devolve false e o fluxo espera
    read() {
      if (offset >= buf.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkBytes, buf.length);
      const chunk = buf.subarray(offset, end);
      offset = end;
      this.push(chunk);
    },
  });
}

/** Duração em ms de um PCM no formato do Discord (48 kHz estéreo s16le = 192 bytes/ms). */
export function pcmDurationMs(buf) {
  if (!Buffer.isBuffer(buf)) return 0;
  return buf.length / (DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * 2 / 1000);
}
