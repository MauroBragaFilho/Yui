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
export const KNOWN_PROVIDERS = Object.freeze(['sapi', 'edge', 'azure']);

/** Provedores previstos mas ainda não implementados (ficam para depois). */
export const PLANNED_PROVIDERS = Object.freeze(['piper']);

export function getTtsConfig(env = process.env) {
  return {
    enabled: masterSwitch(env, 'YUI_TTS_ENABLED', true),
    // Com a nuvem ligada (YUI_TTS_CLOUD=true) a voz neural vem primeiro e o SAPI fica de reserva.
    // Nuvem + chave do Azure: azure (oficial) > edge > SAPI. A chave nunca entra neste objeto: só se ela EXISTE.
    providers: list(env, 'YUI_TTS_PROVIDERS', bool(env, 'YUI_TTS_CLOUD', false) ? (String(env.AZURE_SPEECH_KEY || '').trim() ? ['azure', 'edge', 'sapi'] : ['edge', 'sapi']) : ['sapi']),
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

    personaVoiceFile: String(env.YUI_PERSONA_VOICE_FILE || 'persona/yui-voz.md').trim(),
  };
}
