/**
 * Ajuste do MP3 ao limite de upload do Discord (TG-02) e limpeza das tags de origem (TG-21).
 *
 * Por que existe: o servidor do dono aceita 10 MB por anexo, mas um MP3 de 320 kbps (Deezer) passa disso com
 * 4 min 22 s, e uma faixa de 8 minutos a 192 kbps também. Antes, o arquivo era baixado inteiro e só no envio
 * o Discord recusava (erro 40005). Agora os PRODUTORES (downloadAudio, o Spotify e o Deezer) chamam
 * prepareAudioForDelivery no fim do download: se o arquivo passa do limite, ele é recomprimido com o ffmpeg
 * (192, 128 e 96 kbps, nessa ordem, parando no primeiro que couber).
 *
 * Regras:
 *  - SÓ quando o arquivo vai ser enviado (shouldFitForUpload): o Modo Rádio toca o arquivo local e nunca o
 *    envia, então nunca é recomprimido nem tem as tags mexidas. Quem não envia passa `skipUploadFit: true`.
 *  - O limite vem de getUploadLimitBytes: a base de 10 MiB (fator 0,95) quando o contexto não traz a guild.
 *  - YUI_AUDIO_REENCODE=false desliga a recompressão: o arquivo grande vira um aviso claro ("passou do limite").
 *  - YUI_AUDIO_FIT_TIMEOUT_S (padrão 120) é o prazo de CADA execução do ffmpeg. No máximo 2 ffmpeg ao mesmo tempo.
 *  - ffmpeg sempre por execFile com ARRAY de argumentos (sem shell); a árvore de processos é encerrada no prazo.
 *  - Depois do ajuste, tira do MP3 as tags de URL (frames W***, como WOAS), de comentário (COMM) e os TXXX de origem
 *    (comment, purl, description, url, source...) para o arquivo entregue não carregar de onde veio. Título, artista
 *    e álbum ficam. Qualquer estrutura inesperada deixa o arquivo como está. Falha aqui nunca derruba a entrega.
 *
 * Módulo sem efeito ao importar: não cria pastas, processos nem timers e não usa o logger (quem registra é
 * o chamador, com describePrepared). Tudo que toca o sistema é injetável (execFileImpl, killImpl, fsImpl...).
 */
import fs from 'node:fs';
import path from 'node:path';
import { MediaError, runTool, isMissingBinary, resolveBinaryPath } from './mediaUrls.js';
import { getUploadLimitBytes, formatMB, formatUploadLimit, limitLabelMB, maxAudioMinutes } from './uploadLimit.js';

/** Origens que só tocam o arquivo localmente (nunca enviam ao Discord). Mesma lista do limite de duração. */
export const RADIO_SOURCES = Object.freeze(['Modo Rádio', 'Modo Radio', 'Rádio', 'Radio']);
const RADIO_SET = new Set(RADIO_SOURCES);

/** Bitrates tentados na recompressão, do melhor para o menor. */
export const FIT_BITRATES = Object.freeze([192, 128, 96]);
/** Quantos ffmpeg de ajuste podem rodar ao mesmo tempo. */
export const FIT_MAX_PARALLEL = 2;

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 900;
const PROBE_TIMEOUT_MS = 15_000;
const FFMPEG_MAX_BUFFER = 1024 * 1024;
const OFF_WORDS = new Set(['false', '0', 'no', 'off', 'nao', 'não', 'desligado']);
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/** YUI_AUDIO_REENCODE (padrão ligado; false/0/no/off desliga) e YUI_AUDIO_FIT_TIMEOUT_S (10 a 900; padrão 120). */
export function readAudioFitConfig(env = process.env) {
    const flag = String(env?.YUI_AUDIO_REENCODE ?? '').trim().toLowerCase();
    const raw = Number.parseInt(String(env?.YUI_AUDIO_FIT_TIMEOUT_S ?? '').trim(), 10);
    const seconds = Number.isFinite(raw) && raw >= MIN_TIMEOUT_S && raw <= MAX_TIMEOUT_S ? raw : DEFAULT_TIMEOUT_S;
    return { reencode: !OFF_WORDS.has(flag), timeoutMs: seconds * 1000 };
}

/**
 * O arquivo deste contexto vai ser ENVIADO ao Discord? Falso para o Modo Rádio e para `skipUploadFit: true`.
 * Sem contexto (null) vale como envio, que é o caso seguro.
 */
export function shouldFitForUpload(context) {
    if (!context) return true;
    if (context.skipUploadFit === true) return false;
    return !RADIO_SET.has(context.source);
}

/**
 * Duração máxima (minutos, inteiro) de uma faixa que ainda cabe no limite a 96 kbps, o último degrau da
 * recompressão. 0 quando a recompressão está desligada: sem ela não há garantia, então a checagem prévia
 * por duração não se aplica e vale a checagem de tamanho depois do download.
 */
export function audioUploadMaxMinutes(limitBytes, env = process.env) {
    if (!readAudioFitConfig(env).reencode) return 0;
    return Math.max(0, Math.floor(maxAudioMinutes(limitBytes, FIT_BITRATES[FIT_BITRATES.length - 1])));
}

// ---------------------------------------------------------------------------
// Semáforo (no máximo FIT_MAX_PARALLEL ffmpeg de ajuste juntos)
// ---------------------------------------------------------------------------

export function createSemaphore(max = FIT_MAX_PARALLEL) {
    const capacity = Math.max(1, Math.floor(Number(max)) || 1);
    let active = 0;
    const waiting = [];
    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = waiting.shift();
            if (next) next(makeRelease()); // a vaga passa direto para quem espera
            else active--;
        };
    };
    return {
        acquire() {
            if (active < capacity) {
                active++;
                return Promise.resolve(makeRelease());
            }
            return new Promise((resolve) => waiting.push(resolve));
        },
        get active() { return active; },
        get waiting() { return waiting.length; },
    };
}

const defaultGate = createSemaphore(FIT_MAX_PARALLEL);

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

// Limite em texto: "10 MB" para os limites do Discord; limites pequenos (testes) saem em bytes legíveis.
function limitText(limitBytes) {
    return limitBytes >= MIB * 0.9 && limitLabelMB(limitBytes) >= 1 ? formatUploadLimit(limitBytes) : formatMB(limitBytes);
}

/** Erro "passou do limite de envio" (curto e claro; o detalhe vai só para o log). */
export function uploadTooLargeError({ sizeBytes, limitBytes, reencode = true } = {}) {
    const limit = limitText(limitBytes);
    let message;
    if (reencode) {
        const minutes = Math.floor(maxAudioMinutes(limitBytes, FIT_BITRATES[FIT_BITRATES.length - 1]));
        message = minutes >= 1
            ? `O arquivo ficou maior que o limite de envio do Discord (${limit}), mesmo comprimido. Tente uma faixa de até ${minutes} minutos.`
            : `O arquivo ficou maior que o limite de envio do Discord (${limit}), mesmo comprimido. Tente uma faixa bem mais curta.`;
    } else {
        message = `O arquivo (${formatMB(sizeBytes)}) passou do limite de envio do Discord (${limit}). Tente uma faixa mais curta.`;
    }
    return new MediaError('UPLOAD_TOO_LARGE', message, { detail: `tamanho ${sizeBytes} bytes > limite ${limitBytes} bytes` });
}

// ---------------------------------------------------------------------------
// Duração (ffmpeg -i, só quando o produtor não sabe)
// ---------------------------------------------------------------------------

/** "Duration: 00:03:45.12" na saída de erro do ffmpeg -> 225.12 (segundos); null se não achar. */
export function parseDurationSeconds(text) {
    const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text ?? ''));
    if (!match) return null;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Duração do arquivo pelo banner do ffmpeg (sai com erro por falta de saída, mas imprime a duração). Nunca lança. */
export async function probeDurationSeconds(filePath, { ffmpegPath = 'ffmpeg', execFileImpl, killImpl, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    try {
        const run = await runTool(resolveBinaryPath(ffmpegPath), ['-hide_banner', '-nostdin', '-i', filePath], {
            timeoutMs, maxBuffer: FFMPEG_MAX_BUFFER, cwd: path.dirname(filePath), execFileImpl, killImpl,
        });
        return parseDurationSeconds(`${run.stderr}\n${run.stdout}`);
    } catch {
        return null;
    }
}

/** Bytes esperados de um MP3 CBR (2% e 8 KB de folga para o Xing e as tags). */
function estimateMp3Bytes(seconds, kbps) {
    return Math.ceil(seconds * kbps * 125 * 1.02) + 8192;
}

// ---------------------------------------------------------------------------
// Recompressão
// ---------------------------------------------------------------------------

function lastLine(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    return (lines[lines.length - 1] || '').slice(0, 300);
}

function removeQuietly(file) {
    try { if (file) fs.unlinkSync(file); } catch { /* já não existe */ }
}

function replaceFile(temp, destination) {
    try {
        fs.renameSync(temp, destination);
    } catch {
        fs.copyFileSync(temp, destination);
        removeQuietly(temp);
    }
}

// Chaves de metadados que o ffmpeg grava como TXXX/COMM e que dizem de onde o arquivo veio (valor vazio apaga a chave).
// comment/description/purl/url são o que o ffmpeg e o yt-dlp gravam por padrão; synopsis, episode_id (o ID do vídeo) e show só aparecem se o
// dono ligar --embed-metadata no yt-dlp (YUI_YTDLP_EXTRA_FLAGS), mas também dizem de onde veio o arquivo.
const SOURCE_METADATA_KEYS = Object.freeze(['comment', 'description', 'purl', 'url', 'synopsis', 'episode_id', 'show']);

/**
 * Argumentos do ffmpeg (ARRAY): só a primeira faixa de áudio, sem capa, MP3 CBR no bitrate pedido. Título, artista e
 * álbum são copiados; comentário, descrição e URLs não (o arquivo entregue não diz de onde veio).
 */
export function buildFitArgs(inputPath, outputPath, kbps) {
    return [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', inputPath,
        '-vn', '-map', '0:a:0',
        '-map_metadata', '0',
        ...SOURCE_METADATA_KEYS.flatMap((key) => ['-metadata', `${key}=`]),
        '-id3v2_version', '3',
        '-c:a', 'libmp3lame', '-b:a', `${kbps}k`,
        '-f', 'mp3', outputPath,
    ];
}

/**
 * Garante que o MP3 caiba no limite de upload. Devolve { filePath, changed, originalBytes, finalBytes, bitrateKbps,
 * attempts, limitBytes } (o arquivo é substituído NO MESMO caminho). Lança MediaError('UPLOAD_TOO_LARGE', ...) quando
 * nada cabe ou a recompressão está desligada, e AUDIO_FIT_* quando o ffmpeg falha, some ou estoura o prazo.
 *
 * options: { guild, limitBytes, env, durationSeconds, ffmpegPath, execFileImpl, killImpl, semaphore, timeoutMs }
 */
export async function fitAudioToUpload(filePath, options = {}) {
    const env = options.env || process.env;
    const config = readAudioFitConfig(env);
    const limitBytes = Number.isFinite(options.limitBytes) && options.limitBytes > 0
        ? Math.floor(options.limitBytes)
        : getUploadLimitBytes(options.guild, env);

    let originalBytes;
    try {
        originalBytes = fs.statSync(filePath).size;
    } catch {
        return { filePath, changed: false, skipped: 'missing', originalBytes: 0, finalBytes: 0, bitrateKbps: null, attempts: [], limitBytes };
    }
    const result = { filePath, changed: false, originalBytes, finalBytes: originalBytes, bitrateKbps: null, attempts: [], limitBytes };
    if (originalBytes <= limitBytes) return result;

    if (!config.reencode) throw uploadTooLargeError({ sizeBytes: originalBytes, limitBytes, reencode: false });

    const ffmpeg = options.ffmpegPath || 'ffmpeg';
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : config.timeoutMs;
    let duration = Number(options.durationSeconds);
    if (!(duration > 0)) {
        duration = await probeDurationSeconds(filePath, { ffmpegPath: ffmpeg, execFileImpl: options.execFileImpl, killImpl: options.killImpl });
    }
    // Com a duração conhecida, degraus que não podem caber nem são tentados (poupa CPU e tempo).
    const plan = FIT_BITRATES.filter((kbps) => !(duration > 0) || estimateMp3Bytes(duration, kbps) <= limitBytes);
    if (!plan.length) throw uploadTooLargeError({ sizeBytes: originalBytes, limitBytes, reencode: true });

    const dir = path.dirname(filePath);
    const stem = path.basename(filePath, path.extname(filePath));
    const release = await (options.semaphore || defaultGate).acquire();
    let temp = null;
    try {
        for (const kbps of plan) {
            temp = path.join(dir, `${stem}.fit${kbps}.part`);
            removeQuietly(temp);
            const run = await runTool(resolveBinaryPath(ffmpeg), buildFitArgs(filePath, temp, kbps), {
                timeoutMs, maxBuffer: FFMPEG_MAX_BUFFER, cwd: dir, execFileImpl: options.execFileImpl, killImpl: options.killImpl,
            });
            if (run.error) {
                const detail = lastLine(run.stderr) || (run.error && run.error.message) || '';
                if (isMissingBinary(run)) {
                    throw new MediaError('AUDIO_FIT_UNAVAILABLE',
                        'Não consegui compactar o áudio para caber no limite de envio: a ferramenta de áudio não está disponível. Avise o dono.', { detail, cause: run.error });
                }
                if (run.timedOut) {
                    throw new MediaError('AUDIO_FIT_TIMEOUT',
                        'A compactação do áudio demorou demais e foi cancelada. Tente uma faixa mais curta.', { detail: `prazo de ${Math.round(timeoutMs / 1000)} s a ${kbps} kbps`, cause: run.error });
                }
                throw new MediaError('AUDIO_FIT_FAILED', 'Não consegui compactar o áudio para caber no limite de envio.', { detail, cause: run.error });
            }
            let size = 0;
            try { size = fs.statSync(temp).size; } catch { /* sem saída */ }
            result.attempts.push({ kbps, bytes: size });
            if (size > 0 && size <= limitBytes) {
                replaceFile(temp, filePath);
                temp = null;
                return { ...result, changed: true, finalBytes: size, bitrateKbps: kbps };
            }
            removeQuietly(temp);
            temp = null;
            if (size === 0) {
                throw new MediaError('AUDIO_FIT_FAILED', 'Não consegui compactar o áudio para caber no limite de envio.', { detail: `saída vazia a ${kbps} kbps` });
            }
        }
        throw uploadTooLargeError({ sizeBytes: originalBytes, limitBytes, reencode: true });
    } finally {
        removeQuietly(temp);
        release();
    }
}

// ---------------------------------------------------------------------------
// Tags de origem (URL e comentário) em ID3v2.3/2.4 e no comentário do ID3v1
// ---------------------------------------------------------------------------

const MAX_STRIP_BYTES = 64 * MIB; // acima disso o arquivo não é lido inteiro para limpar tags (o upload base é de 10 MiB)

function readSynchsafe(buf, offset) {
    const bytes = [buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]];
    if (bytes.some((b) => b === undefined || (b & 0x80))) return -1;
    return (bytes[0] << 21) | (bytes[1] << 14) | (bytes[2] << 7) | bytes[3];
}

function writeSynchsafe(buf, offset, value) {
    buf[offset] = (value >> 21) & 0x7f;
    buf[offset + 1] = (value >> 14) & 0x7f;
    buf[offset + 2] = (value >> 7) & 0x7f;
    buf[offset + 3] = value & 0x7f;
}

// Descrições de TXXX que dizem de onde veio o arquivo (o ffmpeg grava comment, purl e description assim).
const SOURCE_TXXX_RE = /^(?:comments?|description|purl|url|website|source|sourceid|download[_ ]?url|synopsis|episode[_ ]?id|show)$/i;

// Descrição de um frame TXXX (codificação 0 = latin1, 1 = UTF-16 com BOM, 2 = UTF-16BE, 3 = UTF-8). '' se ilegível.
function txxxDescription(data) {
    if (!data || data.length < 2) return '';
    const encoding = data[0];
    const body = data.subarray(1);
    try {
        if (encoding === 0 || encoding === 3) {
            const end = body.indexOf(0);
            return body.subarray(0, end < 0 ? body.length : end).toString(encoding === 0 ? 'latin1' : 'utf8').trim();
        }
        if (encoding === 1 || encoding === 2) {
            let end = body.length;
            for (let i = 0; i + 1 < body.length; i += 2) {
                if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
            }
            let slice = body.subarray(0, end);
            let label = encoding === 2 ? 'utf-16be' : 'utf-16le';
            if (encoding === 1 && slice.length >= 2) {
                if (slice[0] === 0xff && slice[1] === 0xfe) { slice = slice.subarray(2); label = 'utf-16le'; }
                else if (slice[0] === 0xfe && slice[1] === 0xff) { slice = slice.subarray(2); label = 'utf-16be'; }
            }
            return new TextDecoder(label).decode(slice).trim();
        }
    } catch { /* descrição ilegível: o frame fica */ }
    return '';
}

/**
 * Frame que carrega de onde veio o arquivo: URL (W***: WOAS, WXXX...), comentário (COMM) ou um TXXX com descrição de
 * origem (comment, purl, url, source...). `data` (o conteúdo do frame) só é preciso para o TXXX.
 */
export function isSourceFrame(id, data) {
    if (id === 'COMM' || id[0] === 'W') return true;
    if (id === 'TXXX' && data) return SOURCE_TXXX_RE.test(txxxDescription(data));
    return false;
}

// Tira os frames de origem do ID3v2. Devolve { buffer, removed } ou null (nada a tirar ou estrutura inesperada:
// nesse caso o arquivo fica EXATAMENTE como está).
function stripId3v2(buf) {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
    const major = buf[3];
    const flags = buf[5];
    if (major !== 3 && major !== 4) return null;
    if (flags & 0xd0) return null; // sincronização da tag inteira, cabeçalho estendido ou rodapé: não mexe
    const tagSize = readSynchsafe(buf, 6);
    if (tagSize < 0) return null;
    const tagEnd = 10 + tagSize;
    if (tagEnd > buf.length) return null;

    const kept = [];
    const removed = [];
    let pos = 10;
    while (pos + 10 <= tagEnd) {
        if (buf[pos] === 0) break; // início do preenchimento
        const id = buf.toString('latin1', pos, pos + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) return null;
        const size = major === 4 ? readSynchsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
        if (size < 0) return null;
        const end = pos + 10 + size;
        if (end > tagEnd) return null;
        // O conteúdo do TXXX só é lido quando o frame não tem flags (compressão, criptografia, sincronização): senão ele fica.
        const plainFrame = buf[pos + 8] === 0 && buf[pos + 9] === 0;
        if (isSourceFrame(id, plainFrame ? buf.subarray(pos + 10, end) : null)) removed.push(id);
        else kept.push(buf.subarray(pos, end));
        pos = end;
    }
    if (!removed.length) return null;

    const body = Buffer.concat(kept);
    const header = Buffer.from(buf.subarray(0, 10));
    writeSynchsafe(header, 6, body.length);
    return { buffer: Buffer.concat([header, body, buf.subarray(tagEnd)]), removed };
}

// Faixa de bytes do comentário do ID3v1 (últimos 128 bytes, "TAG") quando ele tem conteúdo; null se não há tag ou o campo já está vazio.
function dirtyId3v1Comment(buf) {
    if (buf.length < 128) return null;
    const start = buf.length - 128;
    if (buf.toString('latin1', start, start + 3) !== 'TAG') return null;
    const v11 = buf[start + 125] === 0 && buf[start + 126] !== 0; // ID3v1.1: o byte 126 é o número da faixa
    const from = start + 97;
    const to = from + (v11 ? 28 : 30);
    for (let i = from; i < to; i++) {
        if (buf[i] !== 0) return { from, to };
    }
    return null;
}

/** Versão pura (buffer -> buffer) de stripSourceTags. Devolve { buffer, changed, removed, v1CommentCleared }. */
export function stripSourceTagsFromBuffer(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const v2 = stripId3v2(buf);
    const range = dirtyId3v1Comment(v2 ? v2.buffer : buf);
    if (!v2 && !range) return { buffer: buf, changed: false, removed: [], v1CommentCleared: false };
    // Só copia o arquivo inteiro quando precisa mexer no ID3v1 sem ter reescrito o ID3v2 (a entrada nunca é alterada).
    const work = v2 ? v2.buffer : Buffer.from(buf);
    if (range) work.fill(0, range.from, range.to);
    return { buffer: work, changed: true, removed: v2 ? v2.removed : [], v1CommentCleared: Boolean(range) };
}

/**
 * Tira do MP3 as tags de URL (W***) e de comentário (COMM) do ID3v2 e o comentário do ID3v1, sem perder título,
 * artista, álbum nem o áudio. NUNCA lança: qualquer dúvida deixa o arquivo como está.
 * Devolve { changed, removed, v1CommentCleared, error? }.
 */
export function stripSourceTags(filePath, { fsImpl = fs, maxBytes = MAX_STRIP_BYTES } = {}) {
    const temp = `${filePath}.tags.tmp`;
    try {
        const stat = fsImpl.statSync(filePath);
        if (!stat.isFile() || stat.size < 10 || stat.size > maxBytes) return { changed: false, removed: [], v1CommentCleared: false };
        const outcome = stripSourceTagsFromBuffer(fsImpl.readFileSync(filePath));
        if (!outcome.changed) return { changed: false, removed: [], v1CommentCleared: false };
        fsImpl.writeFileSync(temp, outcome.buffer);
        try {
            fsImpl.renameSync(temp, filePath);
        } catch {
            fsImpl.copyFileSync(temp, filePath);
            fsImpl.unlinkSync(temp);
        }
        return { changed: true, removed: outcome.removed, v1CommentCleared: outcome.v1CommentCleared };
    } catch (err) {
        try { fsImpl.unlinkSync(temp); } catch { /* não chegou a existir */ }
        return { changed: false, removed: [], v1CommentCleared: false, error: String(err?.message ?? err).slice(0, 200) };
    }
}

// ---------------------------------------------------------------------------
// Ponto de entrada dos produtores
// ---------------------------------------------------------------------------

/**
 * Prepara o MP3 baixado para a ENTREGA: recomprime se passar do limite de upload e limpa as tags de origem.
 * Não faz nada para o Modo Rádio nem com `skipUploadFit: true` no contexto. Lança MediaError (UPLOAD_TOO_LARGE,
 * AUDIO_FIT_*) quando o arquivo não puder ser entregue; o produtor limpa a pasta do pedido e repassa o erro.
 *
 * options: { context, guild, ...opções de fitAudioToUpload }
 */
export async function prepareAudioForDelivery(filePath, options = {}) {
    const context = options.context || null;
    if (!shouldFitForUpload(context)) return { filePath, skipped: 'not-for-upload', fit: null, tags: null };
    const fit = await fitAudioToUpload(filePath, { ...options, guild: options.guild ?? context?.guild });
    const tags = stripSourceTags(filePath, options.fsImpl ? { fsImpl: options.fsImpl } : undefined);
    return { filePath, skipped: null, fit, tags };
}

/** Resumo para o LOG (nunca para o usuário): "reencodado 12,3 MB -> 8,9 MB a 192 kbps; tags removidas: WOAS, COMM". */
export function describePrepared(prepared) {
    if (!prepared || prepared.skipped) return '';
    const parts = [];
    const fit = prepared.fit;
    if (fit && fit.changed) {
        parts.push(`reencodado ${formatMB(fit.originalBytes)} -> ${formatMB(fit.finalBytes)} a ${fit.bitrateKbps} kbps`);
    }
    const tags = prepared.tags;
    if (tags && tags.changed) {
        const names = [...tags.removed, ...(tags.v1CommentCleared ? ['comentário ID3v1'] : [])];
        if (names.length) parts.push(`tags removidas: ${names.join(', ')}`);
    }
    if (tags && tags.error) parts.push(`limpeza de tags falhou: ${tags.error}`);
    return parts.join('; ');
}
