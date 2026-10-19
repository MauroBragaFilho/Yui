import fs from 'fs';
import path from 'path';
import { MIN_KEY_LENGTH } from '../gateway/providers.js';

/**
 * Chaves e provedores de IA configurados pelo painel (somente o dono).
 *
 * Onde fica: `secrets/ai-providers.json` (fora do Git; troque com YUI_AI_SETTINGS_FILE).
 * Como entra no sistema: `applyAiSettings()` junta o que está no .env com o que foi
 * salvo pelo painel e coloca o resultado em process.env. O .env nunca é reescrito.
 * Quem lê as chaves (config e Gateway) lê process.env na hora, então a mudança vale
 * sem reiniciar a Yui.
 *
 * Segurança:
 *  - As chaves só ENTRAM pela API: nenhuma resposta devolve uma chave, só os 4
 *    últimos caracteres para você reconhecer qual é.
 *  - Chaves do .env aparecem só como quantidade e não podem ser removidas pelo painel.
 *  - URL de provedor próprio: https em qualquer lugar, http só para a sua máquina/rede.
 *  - YUI_PANEL_AI_EDIT=false trava toda edição por aqui.
 */

export class AiSettingsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AiSettingsError';
    this.status = status;
  }
}

/** Provedores conhecidos. `target` é a variável que recebe as chaves do painel. */
export const CATALOG = [
  { id: 'groq', label: 'Groq', target: 'GROQ_API_KEY', envKeys: ['GROQ_API_KEY', 'GROQ_API_KEYS'], url: 'https://console.groq.com/keys', gateway: true },
  { id: 'gemini', label: 'Google Gemini', target: 'GEMINI_API_KEYS', envKeys: ['GEMINI_API_KEYS', 'GEMINI_API_KEY'], url: 'https://aistudio.google.com/app/apikey', gateway: true },
  { id: 'huggingface', label: 'Hugging Face', target: 'HF_TOKEN', envKeys: ['HF_TOKEN'], url: 'https://huggingface.co/settings/tokens', gateway: true },
  { id: 'openrouter', label: 'OpenRouter', target: 'OPENROUTER_API_KEY', envKeys: ['OPENROUTER_API_KEY'], url: 'https://openrouter.ai/keys', gateway: true },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', target: 'CLOUDFLARE_API_TOKEN', envKeys: ['CLOUDFLARE_API_TOKEN'], url: 'https://dash.cloudflare.com/profile/api-tokens', gateway: true, needsAccount: true },
  { id: 'together', label: 'Together AI', target: 'TOGETHER_API_KEY', envKeys: ['TOGETHER_API_KEY'], url: 'https://api.together.ai/settings/api-keys', gateway: true },
  { id: 'stability', label: 'Stability AI (imagens)', target: 'STABILITY_API_KEYS', envKeys: ['STABILITY_API_KEYS', 'STABILITY_API_KEY'], url: 'https://platform.stability.ai/account/keys', gateway: false },
];

/** Modelos de partida para provedores próprios (ex.: OmniRoute). */
export const TEMPLATES = [
  { id: 'omniroute', label: 'OmniRoute', baseUrl: 'http://127.0.0.1:20128/v1', models: ['free-stack'], needsKey: true, first: true, anonymous: true },
  { id: 'outro', label: 'Outro (compatível com OpenAI)', baseUrl: '', models: [], needsKey: false },
];

const RESERVED_IDS = new Set([...CATALOG.map((c) => c.id), 'pollinations', 'auto', 'smart', 'fast']);
const KEY_RE = /^[\x21-\x2b\x2d-\x7e]{10,512}$/; // ASCII visível, sem espaço e sem vírgula
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MODEL_RE = /^[\w.:@/-]{1,120}$/;

/** Prioridade de provedor próprio marcado como "primeiro": antes do Groq (10) e do Gemini (20). */
const FIRST_PRIORITY = 5;

const settingsFile = () => process.env.YUI_AI_SETTINGS_FILE || path.join(process.cwd(), 'secrets', 'ai-providers.json');

export function isEditEnabled(env = process.env) {
  return String(env.YUI_PANEL_AI_EDIT ?? 'true').toLowerCase() !== 'false';
}

const empty = () => ({ version: 1, keys: {}, cloudflareAccountId: '', disabled: [], custom: [] });

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { ...empty(), ...raw, keys: { ...(raw.keys || {}) }, disabled: [...(raw.disabled || [])], custom: [...(raw.custom || [])] };
  } catch {
    return empty();
  }
}

function saveSettings(s) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Mistura com o .env ───────────────────────────────────────────

const MANAGED_ENV = [
  ...new Set([...CATALOG.flatMap((c) => c.envKeys), ...CATALOG.map((c) => c.target), 'CLOUDFLARE_ACCOUNT_ID', 'YUI_GATEWAY_DISABLE', 'YUI_GATEWAY_CUSTOM']),
];
let base = null;

/** Valores do .env antes de qualquer mistura (capturados uma única vez). */
function baseEnv() {
  if (!base) {
    base = {};
    for (const k of MANAGED_ENV) base[k] = process.env[k];
  }
  return base;
}

const csv = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Junta .env + painel e escreve em process.env. Chame depois de salvar e na inicialização. */
export function applyAiSettings() {
  const b = baseEnv();
  const s = loadSettings();
  const set = (name, value) => {
    if (value === undefined || value === '') delete process.env[name];
    else process.env[name] = value;
  };

  for (const k of MANAGED_ENV) set(k, b[k]);

  for (const c of CATALOG) {
    const panelKeys = s.keys[c.id] || [];
    if (panelKeys.length) set(c.target, [...csv(b[c.target]), ...panelKeys].join(','));
  }
  if (s.cloudflareAccountId && !b.CLOUDFLARE_ACCOUNT_ID) set('CLOUDFLARE_ACCOUNT_ID', s.cloudflareAccountId);

  const disabled = [...csv(b.YUI_GATEWAY_DISABLE), ...s.disabled];
  if (disabled.length) set('YUI_GATEWAY_DISABLE', [...new Set(disabled)].join(','));

  // Provedores próprios: entram no YUI_GATEWAY_CUSTOM junto com os do .env.
  let envCustom = [];
  let envCustomOk = true;
  if (b.YUI_GATEWAY_CUSTOM) {
    try {
      const parsed = JSON.parse(b.YUI_GATEWAY_CUSTOM);
      if (Array.isArray(parsed)) envCustom = parsed;
      else envCustomOk = false;
    } catch {
      envCustomOk = false;
    }
  }
  for (const k of Object.keys(process.env)) if (k.startsWith('YUI_PANEL_KEY_')) delete process.env[k];
  if (s.custom.length && envCustomOk) {
    const entries = s.custom.map((c) => {
      const keyVar = `YUI_PANEL_KEY_${c.id.toUpperCase().replace(/-/g, '_')}`;
      if (c.keys?.length) process.env[keyVar] = c.keys.join(',');
      return { id: c.id, label: c.label, baseUrl: c.baseUrl, models: c.models, anonymous: Boolean(c.anonymous), ...(c.keys?.length ? { apiKeyEnv: keyVar } : {}), priority: c.first ? FIRST_PRIORITY : 25 };
    });
    set('YUI_GATEWAY_CUSTOM', JSON.stringify([...envCustom, ...entries]));
  }
}

// ── Validação ────────────────────────────────────────────────────

function checkKey(key) {
  const k = String(key ?? '').trim();
  if (!KEY_RE.test(k)) throw new AiSettingsError(400, 'Chave inválida: use 10 a 512 caracteres visíveis, sem espaços nem vírgulas.');
  return k;
}

function provider(id) {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) throw new AiSettingsError(404, 'Provedor desconhecido.');
  return c;
}

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b2] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b2 === 168) || (a === 172 && b2 >= 16 && b2 <= 31) || (a === 100 && b2 >= 64 && b2 <= 127);
}

export function checkBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new AiSettingsError(400, 'Endereço inválido. Exemplo: http://127.0.0.1:20128/v1');
  }
  if (!/^https?:$/.test(url.protocol)) throw new AiSettingsError(400, 'O endereço deve começar com http:// ou https://.');
  if (url.username || url.password) throw new AiSettingsError(400, 'Não coloque usuário ou senha no endereço; use o campo de chave.');
  if (url.search || url.hash) throw new AiSettingsError(400, 'O endereço não pode ter parâmetros (?...) nem #.');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new AiSettingsError(400, 'Fora da sua máquina/rede, use https:// (senão a chave e as conversas viajariam sem proteção).');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

// ── Alterações (cada uma salva e aplica) ─────────────────────────

function commit(s) {
  saveSettings(s);
  applyAiSettings();
}

export function addKey(providerId, key) {
  const c = provider(providerId);
  const k = checkKey(key);
  const s = loadSettings();
  const list = s.keys[c.id] || [];
  const inEnv = c.envKeys.flatMap((n) => csv(baseEnv()[n]));
  if (list.includes(k) || inEnv.includes(k)) throw new AiSettingsError(409, 'Essa chave já está cadastrada.');
  if (list.length >= 10) throw new AiSettingsError(400, 'Limite de 10 chaves por provedor.');
  s.keys[c.id] = [...list, k];
  commit(s);
  return { count: s.keys[c.id].length };
}

export function removeKey(providerId, index) {
  const c = provider(providerId);
  const s = loadSettings();
  const list = s.keys[c.id] || [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new AiSettingsError(404, 'Chave não encontrada (chaves do .env só se removem no arquivo).');
  list.splice(i, 1);
  if (list.length) s.keys[c.id] = list;
  else delete s.keys[c.id];
  commit(s);
  return { count: list.length };
}

export function setCloudflareAccount(accountId) {
  const id = String(accountId ?? '').trim();
  if (id && !/^[a-f0-9]{32}$/i.test(id)) throw new AiSettingsError(400, 'O ID da conta da Cloudflare tem 32 caracteres (letras a-f e números).');
  const s = loadSettings();
  s.cloudflareAccountId = id;
  commit(s);
  return { ok: true };
}

export function setEnabled(providerId, enabled) {
  const id = String(providerId);
  const known = CATALOG.some((c) => c.id === id && c.gateway) || id === 'pollinations' || loadSettings().custom.some((c) => c.id === id);
  if (!known) throw new AiSettingsError(404, 'Provedor desconhecido.');
  const s = loadSettings();
  s.disabled = enabled ? s.disabled.filter((x) => x !== id) : [...new Set([...s.disabled, id])];
  commit(s);
  return { ok: true };
}

export function addCustom({ id, label, baseUrl, models, key, anonymous = false, first = false } = {}) {
  const cid = String(id ?? '').trim().toLowerCase();
  if (!ID_RE.test(cid)) throw new AiSettingsError(400, 'ID inválido: use letras minúsculas, números e hífen (até 31 caracteres).');
  if (RESERVED_IDS.has(cid)) throw new AiSettingsError(400, 'Esse ID já é de um provedor da Yui. Escolha outro.');
  const url = checkBaseUrl(baseUrl);
  const list = (Array.isArray(models) ? models : String(models ?? '').split(',')).map((m) => String(m).trim()).filter(Boolean);
  if (!list.length || list.length > 10) throw new AiSettingsError(400, 'Informe de 1 a 10 modelos (separados por vírgula).');
  if (!list.every((m) => MODEL_RE.test(m))) throw new AiSettingsError(400, 'Nome de modelo inválido.');
  const keys = key ? [checkKey(key)] : [];
  if (!keys.length && !anonymous) {
    // Servidores locais (OmniRoute, LM Studio) podem não exigir chave: tudo bem, desde que seja da sua rede.
    if (!isPrivateHost(new URL(url).hostname)) throw new AiSettingsError(400, 'Informe a chave de acesso deste provedor.');
  }
  const s = loadSettings();
  if (s.custom.some((c) => c.id === cid)) throw new AiSettingsError(409, 'Já existe um provedor com esse ID.');
  if (s.custom.length >= 10) throw new AiSettingsError(400, 'Limite de 10 provedores próprios.');
  const entry = { id: cid, label: String(label || cid).trim().slice(0, 60), baseUrl: url, models: list, keys, anonymous: Boolean(anonymous) || (!keys.length), first: Boolean(first) };
  s.custom.push(entry);
  commit(s);
  return { id: cid };
}

export function addCustomKey(id, key) {
  const s = loadSettings();
  const c = s.custom.find((x) => x.id === id);
  if (!c) throw new AiSettingsError(404, 'Provedor próprio não encontrado.');
  const k = checkKey(key);
  if ((c.keys || []).includes(k)) throw new AiSettingsError(409, 'Essa chave já está cadastrada.');
  c.keys = [...(c.keys || []), k].slice(0, 10);
  commit(s);
  return { count: c.keys.length };
}

/** Ajustes de um provedor próprio: ir primeiro na fila e aceitar (ou não) conversas pessoais. */
export function setCustomOptions(id, { first, anonymous, models } = {}) {
  const s = loadSettings();
  const c = s.custom.find((x) => x.id === id);
  if (!c) throw new AiSettingsError(404, 'Provedor próprio não encontrado.');
  if (first !== undefined) {
    if (typeof first !== 'boolean') throw new AiSettingsError(400, 'Informe first: true ou false.');
    c.first = first;
  }
  if (models !== undefined) {
    const list = (Array.isArray(models) ? models : String(models ?? '').split(',')).map((m) => String(m).trim()).filter(Boolean);
    if (!list.length || list.length > 10) throw new AiSettingsError(400, 'Informe de 1 a 10 modelos (separados por vírgula).');
    if (!list.every((m) => MODEL_RE.test(m))) throw new AiSettingsError(400, 'Nome de modelo inválido.');
    c.models = list;
  }
  if (anonymous !== undefined) {
    if (typeof anonymous !== 'boolean') throw new AiSettingsError(400, 'Informe anonymous: true ou false.');
    if (anonymous === false && !(c.keys || []).length && !isPrivateHost(new URL(c.baseUrl).hostname)) {
      throw new AiSettingsError(400, 'Para receber conversas pessoais, o provedor precisa de chave.');
    }
    c.anonymous = anonymous;
  }
  commit(s);
  return { first: Boolean(c.first), anonymous: Boolean(c.anonymous), models: c.models };
}

export function removeCustom(id) {
  const s = loadSettings();
  const before = s.custom.length;
  s.custom = s.custom.filter((c) => c.id !== id);
  if (s.custom.length === before) throw new AiSettingsError(404, 'Provedor próprio não encontrado.');
  s.disabled = s.disabled.filter((x) => x !== id);
  commit(s);
  return { ok: true };
}

// ── Leitura para o painel (nunca devolve chaves) ─────────────────

const hint = (k) => `…${k.slice(-4)}`;

export function describeAi({ gateway = null, env = process.env } = {}) {
  const s = loadSettings();
  const b = baseEnv();
  const activeIds = new Set((gateway?.providers || []).map((p) => p.id));
  const providers = CATALOG.map((c) => ({
    id: c.id,
    label: c.label,
    url: c.url,
    needsAccount: Boolean(c.needsAccount),
    accountConfigured: c.needsAccount ? Boolean(b.CLOUDFLARE_ACCOUNT_ID || s.cloudflareAccountId) : null,
    envKeys: [...new Set(c.envKeys.flatMap((n) => csv(b[n])))].filter((k) => k.length >= MIN_KEY_LENGTH).length,
    ignoredEnvKeys: [...new Set(c.envKeys.flatMap((n) => csv(b[n])))].filter((k) => k.length < MIN_KEY_LENGTH).length,
    panelKeys: (s.keys[c.id] || []).map((k, index) => ({ index, hint: hint(k) })),
    enabled: !s.disabled.includes(c.id) && !csv(b.YUI_GATEWAY_DISABLE).includes(c.id),
    toggle: c.gateway,
    active: c.gateway ? activeIds.has(c.id) : null,
  }));
  providers.push({
    id: 'pollinations', label: 'Pollinations (grátis, anônimo)', url: null, needsAccount: false, accountConfigured: null,
    envKeys: 0, panelKeys: [], enabled: !s.disabled.includes('pollinations') && !csv(b.YUI_GATEWAY_DISABLE).includes('pollinations'),
    toggle: true, active: activeIds.has('pollinations'), keyless: true,
  });
  const custom = s.custom.map((c) => ({
    id: c.id, label: c.label, baseUrl: c.baseUrl, models: c.models,
    keys: (c.keys || []).map((k, index) => ({ index, hint: hint(k) })),
    anonymous: Boolean(c.anonymous), first: Boolean(c.first), enabled: !s.disabled.includes(c.id), active: activeIds.has(c.id), source: 'panel',
  }));
  let envCustom = [];
  try {
    const parsed = JSON.parse(b.YUI_GATEWAY_CUSTOM || '[]');
    envCustom = Array.isArray(parsed) ? parsed.map((c) => ({ id: String(c.id), label: String(c.label || c.id), baseUrl: String(c.baseUrl || c.endpoint || ''), models: c.models || [], keys: [], anonymous: Boolean(c.anonymous), enabled: true, active: activeIds.has(String(c.id)), source: 'env' })) : [];
  } catch {
    /* JSON inválido no .env: o Gateway já avisa no log */
  }
  return { editable: isEditEnabled(env), providers, custom: [...envCustom, ...custom], templates: TEMPLATES };
}
