/**
 * Configuração do TTS (a Yui falando na call de voz).
 *
 * Fonte única dos padrões e limites. `getTtsConfig()` lê o ambiente NA HORA (não
 * guarda cache), então os testes mudam `process.env` e chamam de novo. Valor
 * ausente, vazio ou inválido cai no padrão; números ficam dentro de limites
 * seguros para um valor digitado errado não travar nem estourar o PC.
 *
 * Este módulo é puro: sem efeitos colaterais ao importar e sem ler segredos.
 */

function num(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function int(env, name, def, min, max) {
  return Math.round(num(env, name, def, min, max));
}

const TRUE_WORDS = ['1', 'true', 'on', 'yes', 'sim', 's'];
const FALSE_WORDS = ['0', 'false', 'off', 'no', 'nao', 'não', 'n'];

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (TRUE_WORDS.includes(v)) return true;
  if (FALSE_WORDS.includes(v)) return false;
  return def;
}

/**
 * Chave mestra (falha FECHADA): ausente ou vazia usa o padrão, mas um valor escrito e não reconhecido
 * ("falso", "desligado", "disabled"...) DESLIGA. Quem digitou algo para desligar não pode ficar com a Yui falando.
 */
function masterSwitch(env, name, def) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  return TRUE_WORDS.includes(String(raw).trim().toLowerCase());
}

function list(env, name, def) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const items = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : def;
}

/** Provedores que existem nesta versão. Os demais nomes são ignorados com aviso. */
export const KNOWN_PROVIDERS = Object.freeze(['sapi', 'edge', 'azure', 'omniroute']);

/** Padrão de quanto a fala espera pela 1ª frase (output.js) e base do orçamento de nuvem do motor (engine.js). */
export const FIRST_SENTENCE_WAIT_MS = 20_000;

/** Provedores previstos mas ainda não implementados (ficam para depois). */
export const PLANNED_PROVIDERS = Object.freeze(['piper']);

// ── Voz pelo OmniRoute (POST /v1/audio/speech, compatível com a OpenAI) ───────────────────────────────────────────────────────────
// O modelo e a voz vêm SÓ destas chaves (o código não presume o prefixo do modelo; o do Gemini é o padrão de hoje). Validados aqui porque
// vão no corpo JSON da chamada: valor com caractere estranho cai no padrão, nunca é repassado.
export const DEFAULT_OMNIROUTE_MODEL = 'google/gemini-3.8-flash-tts';
export const DEFAULT_OMNIROUTE_VOICE = 'Leda';
/** O estilo padrão (em inglês: o Gemini TTS entende melhor), usado só com um modelo do Gemini e sem YUI_TTS_OMNIROUTE_ESTILO. */
export const DEFAULT_OMNIROUTE_STYLE = 'Say in a warm, natural and slightly playful tone, in Brazilian Portuguese';
const OMNIROUTE_NAME_RE = /^[A-Za-z0-9][\w.:@/-]{0,119}$/;
const OMNIROUTE_VOICE_RE = /^[A-Za-z0-9][\w.:@/-]{0,79}$/;

export function safeOmnirouteModel(value, fallback = DEFAULT_OMNIROUTE_MODEL) {
  const v = String(value ?? '').trim();
  return OMNIROUTE_NAME_RE.test(v) ? v : fallback;
}

export function safeOmnirouteVoice(value, fallback = DEFAULT_OMNIROUTE_VOICE) {
  const v = String(value ?? '').trim();
  return OMNIROUTE_VOICE_RE.test(v) ? v : fallback;
}

/** O modelo é da família Gemini (aceita instrução de estilo no texto e as marcas <short pause>, <laugh>...)? */
export function isGeminiTtsModel(model) {
  return /gemini/i.test(String(model ?? ''));
}

/**
 * A instrução de estilo da voz: `null` = não definida (vale o padrão, só para modelo do Gemini); `''` = "nenhum" (texto puro);
 * senão o texto, sem controle, em uma linha e com no máximo 200 caracteres.
 */
export function cleanOmnirouteStyle(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^(nenhum|nenhuma|none|off)$/i.test(raw)) return '';
  const clean = raw.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return clean || null;
}

export function getTtsConfig(env = process.env) {
  const omniroute = bool(env, 'YUI_TTS_OMNIROUTE', false);
  const cloudProviders = bool(env, 'YUI_TTS_CLOUD', false) ? (String(env.AZURE_SPEECH_KEY || '').trim() ? ['azure', 'edge', 'sapi'] : ['edge', 'sapi']) : ['sapi'];
  return {
    enabled: masterSwitch(env, 'YUI_TTS_ENABLED', true),
    // Com a nuvem ligada (YUI_TTS_CLOUD=true) a voz neural vem primeiro e o SAPI fica de reserva.
    // Nuvem + chave do Azure: azure (oficial) > edge > SAPI. A chave nunca entra neste objeto: só se ela EXISTE.
    // Com YUI_TTS_OMNIROUTE=true o omniroute vai na frente de tudo (omniroute > azure > edge > SAPI); uma lista escrita em YUI_TTS_PROVIDERS vale como está.
    providers: list(env, 'YUI_TTS_PROVIDERS', omniroute ? ['omniroute', ...cloudProviders] : cloudProviders),
    cloud: bool(env, 'YUI_TTS_CLOUD', false),
    voiceTools: bool(env, 'YUI_VOICE_TOOLS', false),

    // Quanto a Yui fala por resposta. A voz Maria (SAPI) lê ~12 caracteres/s.
    maxChars: int(env, 'YUI_TTS_MAX_CHARS', 220, 60, 600),
    maxSentences: int(env, 'YUI_TTS_MAX_SENTENCES', 3, 1, 6),
    maxSentenceChars: int(env, 'YUI_TTS_MAX_SENTENCE_CHARS', 160, 60, 400),
    maxSeconds: int(env, 'YUI_TTS_MAX_SECONDS', 25, 5, 60),
    staleSeconds: int(env, 'YUI_TTS_STALE_SECONDS', 30, 5, 300),

    // Limites contra abuso e laço (eco do microfone).
    userGapSeconds: int(env, 'YUI_TTS_USER_GAP_SECONDS', 6, 0, 120),
    userPerMin: int(env, 'YUI_TTS_USER_PER_MIN', 5, 1, 60),
    guildPerMin: int(env, 'YUI_TTS_GUILD_PER_MIN', 8, 1, 120),
    globalPerMin: int(env, 'YUI_TTS_GLOBAL_PER_MIN', 12, 1, 240),
    guildSecondsPer10Min: int(env, 'YUI_TTS_GUILD_SECONDS_PER_10MIN', 120, 10, 1200),
    queueMax: int(env, 'YUI_TTS_QUEUE_MAX', 3, 1, 10),

    // Interrupção e anti-eco.
    bargeIn: bool(env, 'YUI_TTS_BARGE_IN', true),
    bargeInMs: int(env, 'YUI_TTS_BARGE_IN_MS', 800, 200, 5000),
    echoGuardMs: int(env, 'YUI_TTS_ECHO_GUARD_MS', 1500, 0, 10000),

    // Processo residente do SAPI.
    idleMinutes: int(env, 'YUI_TTS_IDLE_MINUTES', 10, 1, 240),
    sapiVoice: String(env.YUI_TTS_SAPI_VOICE || '').trim(),
    sapiRate: int(env, 'YUI_TTS_SAPI_RATE', 0, -10, 10),

    // Prazos por etapa (ms).
    sapiTimeoutMs: int(env, 'YUI_TTS_SAPI_TIMEOUT_MS', 4000, 1000, 30000),
    sapiColdTimeoutMs: int(env, 'YUI_TTS_SAPI_COLD_TIMEOUT_MS', 15000, 3000, 60000),

    // Voz neural da nuvem (Edge): voz calma por padrão; o texto falado sai do PC (só texto não sensível).
    // Azure Speech (oficial): região e voz/estilo/tom/velocidade; teto mensal abaixo da faixa gratuita de 500 mil.
    azureRegion: String(env.AZURE_SPEECH_REGION || '').trim(),
    azureVoice: String(env.YUI_TTS_AZURE_VOICE || 'pt-BR-ThalitaMultilingualNeural').trim(),
    azureStyle: String(env.YUI_TTS_AZURE_STYLE || '').trim(),
    azureRate: String(env.YUI_TTS_AZURE_RATE || '+0%').trim(),
    azurePitch: String(env.YUI_TTS_AZURE_PITCH || '+0Hz').trim(),
    azureMaxCharsPerMonth: int(env, 'YUI_TTS_AZURE_MAX_CHARS_PER_MONTH', 450000, 1000, 100000000),
    azureTimeoutMs: int(env, 'YUI_TTS_AZURE_TIMEOUT_MS', 8000, 2000, 30000),
    azureColdTimeoutMs: int(env, 'YUI_TTS_AZURE_COLD_TIMEOUT_MS', 12000, 3000, 60000),
    edgeVoice: String(env.YUI_TTS_EDGE_VOICE || 'pt-BR-FranciscaNeural').trim(),
    edgeRate: String(env.YUI_TTS_EDGE_RATE || '-4%').trim(),
    edgePitch: String(env.YUI_TTS_EDGE_PITCH || '+0Hz').trim(),
    edgeMaxCharsPerDay: int(env, 'YUI_TTS_EDGE_MAX_CHARS_PER_DAY', 100000, 1000, 2000000),
    edgeTimeoutMs: int(env, 'YUI_TTS_EDGE_TIMEOUT_MS', 8000, 2000, 30000),
    edgeColdTimeoutMs: int(env, 'YUI_TTS_EDGE_COLD_TIMEOUT_MS', 12000, 3000, 60000),

    // Voz pelo OmniRoute (o endereço e a chave NÃO estão aqui: vêm do provedor "omniroute" que a Yui já usa para a IA, em src/gateway/providers.js).
    // Desligado por padrão. `omnirouteSensitive`: texto sensível (conversa privada) só vai ao OmniRoute com YUI_TTS_OMNIROUTE_SENSIVEL=true.
    omniroute,
    omnirouteModel: safeOmnirouteModel(env.YUI_TTS_OMNIROUTE_MODELO),
    omnirouteVoice: safeOmnirouteVoice(env.YUI_TTS_OMNIROUTE_VOZ),
    omnirouteStyle: cleanOmnirouteStyle(env.YUI_TTS_OMNIROUTE_ESTILO),
    omnirouteSensitive: bool(env, 'YUI_TTS_OMNIROUTE_SENSIVEL', false),
    omnirouteDailyCap: int(env, 'YUI_TTS_OMNIROUTE_TETO_DIA', 400, 1, 100000),
    omnirouteTimeoutMs: int(env, 'YUI_TTS_OMNIROUTE_TIMEOUT_MS', 10000, 2000, 60000),
    // Prazo FRIO: a 1ª fala depois de muito tempo parada pode demorar mais (o OmniRoute do notebook com HDD tem a memória paginada para o disco e
    // levou 12,7 s para acordar; depois responde em 0,1 s). Vale só enquanto o provedor está "frio" (omnirouteWarmMinutes sem sucesso) e nunca passa do
    // orçamento de nuvem do motor (firstSentenceWaitMs menos a reserva do provedor local). Nunca fica abaixo do prazo quente.
    omnirouteColdTimeoutMs: int(env, 'YUI_TTS_OMNIROUTE_COLD_TIMEOUT_MS', 14000, 2000, 60000),
    // Quantos minutos sem uma fala bem-sucedida até o OmniRoute voltar a ser considerado frio, e de quantos em quantos minutos (0 = nunca) um toque
    // leve (GET /models, mesma rota e mesma chave da IA) mantém o processo dele na memória enquanto a Yui está numa call com a voz ligada.
    omnirouteWarmMinutes: int(env, 'YUI_TTS_OMNIROUTE_WARM_MINUTES', 5, 1, 240),
    omnirouteKeepaliveMinutes: int(env, 'YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES', 0, 0, 60),
    // Espera (em ms) depois de um 429 de um provedor de nuvem: o disjuntor dele abre NA HORA por esse tempo, em vez de a cota estourada ser tentada de novo a cada frase.
    // 0 (o padrão) = desligado: o comportamento de sempre (o disjuntor só abre depois de várias falhas). Em segundos na chave: YUI_TTS_ESPERA_429_S (0 a 600).
    rateLimitWaitMs: int(env, 'YUI_TTS_ESPERA_429_S', 0, 0, 600) * 1000,

    // Prazo da 1ª frase (quanto a fala espera pela síntese antes de desistir e ficar só em texto) e o ORÇAMENTO DE NUVEM do motor: os provedores de
    // nuvem dividem `firstSentenceWaitMs - localReserveMs`; o provedor local (SAPI) nunca é pulado por falta de tempo. Abaixo de `cloudMinMs` de orçamento
    // restante a nuvem que falta é pulada e a fala vai direto ao local.
    firstSentenceWaitMs: int(env, 'YUI_TTS_FIRST_SENTENCE_WAIT_MS', FIRST_SENTENCE_WAIT_MS, 8000, 60000),
    localReserveMs: int(env, 'YUI_TTS_LOCAL_RESERVE_MS', 7000, 1000, 30000),
    cloudMinMs: int(env, 'YUI_TTS_CLOUD_MIN_MS', 1500, 500, 10000),

    personaVoiceFile: String(env.YUI_PERSONA_VOICE_FILE || 'persona/yui-voz.md').trim(),
  };
}
