/**
 * Provedor AZURE SPEECH (API OFICIAL da Microsoft, NUVEM) para o TTS da Yui.
 *
 * Diferenças para o Edge: é oficial e estável, tem dezenas de vozes pt-BR e ESTILOS de fala
 * ("cheerful", "friendly"...), e devolve PCM cru (raw-24khz-16bit-mono-pcm): sem ffmpeg.
 * Exige conta Azure com um recurso "Speech" (faixa gratuita F0: 500 mil caracteres por mês).
 *
 * Segurança: a chave (AZURE_SPEECH_KEY) vive só no .env; vai SOMENTE no cabeçalho
 * Ocp-Apim-Subscription-Key, nunca em URL, log, erro ou status. A região é validada por regex e o host
 * é sempre <região>.tts.speech.microsoft.com (sem seguir redirecionamento). `local: false`: o motor só o usa
 * com YUI_TTS_CLOUD=true e texto NÃO sensível. Erros só com `code` (AZURE_*), nunca texto nem corpo da resposta.
 * Sem efeito colateral ao importar.
 */

const SAMPLE_RATE = 24000;
const MAX_TEXT_CHARS = 600;
const MAX_PCM_BYTES = 20 * 1024 * 1024;
const USER_AGENT = 'Yui-Discord-Bot/1.0 (https://github.com/MauroBragaFilho/Yui)';

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

export const escapeXml = (text) => String(text ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const safeRegion = (v) => (/^[a-z0-9]{3,30}$/.test(String(v ?? '').trim()) ? String(v).trim() : '');
export const safeVoice = (v, fb) => (/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]{2,40}Neural$/.test(String(v ?? '').trim()) ? String(v).trim() : fb);
export const safeStyle = (v) => (/^[a-z][a-z0-9-]{1,30}$/.test(String(v ?? '').trim()) ? String(v).trim() : '');
export const safeProsody = (v, fb) => (/^[+-]?\d{1,3}(?:\.\d{1,2})?(?:%|Hz|st)$/.test(String(v ?? '').trim()) ? String(v).trim() : fb);

/** SSML montado só pelo código (o texto do usuário entra escapado). */
export function buildSsml({ text, voice, style = '', rate = '+0%', pitch = '+0Hz' }) {
  const lang = voice.split('-').slice(0, 2).join('-');
  const prosody = `<prosody rate="${rate}" pitch="${pitch}">${escapeXml(text)}</prosody>`;
  const inner = style ? `<mstts:express-as style="${style}">${prosody}</mstts:express-as>` : prosody;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}">${inner}</voice></speak>`;
}

/**
 * @param {object} [o]
 * @param {object} [o.config]  getTtsConfig(): azureRegion, azureVoice, azureStyle, azureRate, azurePitch, azureMaxCharsPerMonth
 * @param {object} [o.env]     de onde vem AZURE_SPEECH_KEY (padrão process.env)
 * @param {function} [o.fetchImpl]  injetável (testes)
 */
export function createAzureProvider({ config = {}, env = process.env, logger = null, now = Date.now, fetchImpl = null } = {}) {
  const log = (level, msg) => { try { logger?.[level]?.(msg); } catch { /* ok */ } };
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const key = () => String(env?.AZURE_SPEECH_KEY ?? '').trim();
  const region = safeRegion(config.azureRegion ?? env?.AZURE_SPEECH_REGION);
  const voice = safeVoice(config.azureVoice, 'pt-BR-ThalitaMultilingualNeural');
  const style = safeStyle(config.azureStyle);
  const rate = safeProsody(config.azureRate, '+0%');
  const pitch = safeProsody(config.azurePitch, '+0Hz');
  const maxPerMonth = Number.isFinite(config.azureMaxCharsPerMonth) ? config.azureMaxCharsPerMonth : 450_000;
  let usage = { month: '', chars: 0 };

  function takeQuota(chars) {
    const month = new Date(now()).toISOString().slice(0, 7);
    if (usage.month !== month) usage = { month, chars: 0 };
    if (usage.chars + chars > maxPerMonth) throw failure('AZURE_QUOTA', 'teto mensal de caracteres do Azure');
    usage.chars += chars;
  }

  const host = () => `https://${region}.tts.speech.microsoft.com`;

  async function request(path, init, signal, timeoutMs) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal?.aborted) throw abortedError();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await doFetch(host() + path, { ...init, redirect: 'error', signal: ctl.signal, headers: { 'Ocp-Apim-Subscription-Key': key(), 'User-Agent': USER_AGENT, ...init.headers } });
    } catch (e) {
      if (signal?.aborted) throw abortedError();
      throw failure('AZURE_NETWORK', 'sem resposta do Azure');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return {
    name: 'azure',
    local: false,

    /** Sem rede: confere só que há chave e região válidas. */
    async probe() {
      if (!key()) return { ok: false, detail: 'AZURE_SPEECH_KEY ausente no .env' };
      if (!region) return { ok: false, detail: 'AZURE_SPEECH_REGION ausente ou inválida no .env' };
      return { ok: true, detail: `Azure Speech ${voice}${style ? ` (${style})` : ''} em ${region} (nuvem; rede só na 1ª fala)` };
    },

    async warmup() { /* nada residente */ },

    async synth(text, { signal } = {}) {
      const clean = String(text ?? '').trim();
      if (!clean) throw failure('AZURE_EMPTY', 'texto vazio');
      if (clean.length > MAX_TEXT_CHARS) throw failure('AZURE_TOO_LONG', 'texto longo demais para uma frase');
      if (!key() || !region) throw failure('AZURE_CONFIG', 'Azure sem chave ou região');
      takeQuota(clean.length);
      const t0 = now();
      const res = await request('/cognitiveservices/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm' },
        body: buildSsml({ text: clean, voice, style, rate, pitch }),
      }, signal, 10_000);
      if (!res.ok) {
        const code = res.status === 401 || res.status === 403 ? 'AZURE_AUTH' : res.status === 429 ? 'AZURE_RATE' : 'AZURE_HTTP';
        throw failure(code, `Azure respondeu ${res.status}`);
      }
      const pcm = Buffer.from(await res.arrayBuffer());
      if (!pcm.length) throw failure('AZURE_EMPTY', 'o Azure não devolveu áudio');
      if (pcm.length > MAX_PCM_BYTES) throw failure('AZURE_TOO_BIG', 'áudio grande demais');
      log('info', `[TTS] Azure: ${clean.length} caracteres -> ${pcm.length} bytes de PCM em ${now() - t0} ms`);
      return { pcm, sampleRate: SAMPLE_RATE, channels: 1 };
    },

    /** Vozes pt-BR do recurso (para a página de teste): [{ name, gender, styles }]. */
    async listVoices({ signal } = {}) {
      if (!key() || !region) throw failure('AZURE_CONFIG', 'Azure sem chave ou região');
      const res = await request('/cognitiveservices/voices/list', { method: 'GET', headers: {} }, signal, 10_000);
      if (!res.ok) throw failure(res.status === 401 || res.status === 403 ? 'AZURE_AUTH' : 'AZURE_HTTP', `Azure respondeu ${res.status}`);
      const all = await res.json();
      return (Array.isArray(all) ? all : [])
        .filter((v) => /^pt-/.test(String(v.Locale)))
        .map((v) => ({ name: String(v.ShortName), gender: String(v.Gender), locale: String(v.Locale), styles: Array.isArray(v.StyleList) ? v.StyleList.map(String) : [] }));
    },

    async dispose() { /* nada residente */ },
    getUsage: () => ({ ...usage, maxPerMonth }),
  };
}
