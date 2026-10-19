/**
 * Provedores de IA do Yui Gateway.
 *
 * Cada provedor é um endpoint compatível com a API OpenAI (/chat/completions).
 * Os presets abaixo são ativados SOMENTE se houver chave válida no .env (ou se
 * forem gratuitos e sem chave, como o Pollinations). Chaves curtas demais
 * (< 10 caracteres) são tratadas como "não configurada", para um valor de
 * exemplo esquecido no .env não virar uma tentativa que sempre falha.
 *
 * Ajustes opcionais no .env:
 *   YUI_GATEWAY_DISABLE=pollinations,together     desliga provedores
 *   YUI_GATEWAY_PRIORITY=groq,gemini              ordem de preferência (os demais seguem depois)
 *   YUI_GATEWAY_CUSTOM=[{...}]                    provedores extras (veja loadCustomProviders)
 *   YUI_GATEWAY_COMBOS={"rapido":["groq/openai/gpt-oss-20b","gemini/gemini-2.5-flash-lite"]}
 */

import { currentGeminiModel, isRetiredGeminiModel, GEMINI_FAST, GEMINI_SMART } from '../utils/geminiModels.js';

export const MIN_KEY_LENGTH = 10;

/** Junta variáveis com listas "a,b,c", remove repetidas e chaves curtas demais. */
export function splitKeys(...values) {
  const keys = values
    .flatMap((v) => String(v ?? '').split(','))
    .map((k) => k.trim().replace(/^["']|["']$/g, ''))
    .filter((k) => k.length >= MIN_KEY_LENGTH);
  return [...new Set(keys)];
}

const model = (id, tier = 'smart') => ({ id, tier });

const csv = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Provedores extras definidos pelo dono em YUI_GATEWAY_CUSTOM (JSON):
 *   [{ "id":"meu", "label":"Meu provedor", "baseUrl":"https://x.com/v1" (ou "endpoint": ".../chat/completions"),
 *      "apiKeyEnv":"MEU_PROVEDOR_KEY", "models":["m1","m2"], "priority":15, "anonymous":false }]
 * A chave NUNCA vai no JSON: só o NOME da variável de ambiente que a contém.
 */
export function loadCustomProviders(env = process.env) {
  const raw = String(env.YUI_GATEWAY_CUSTOM ?? '').trim();
  if (!raw) return { providers: [], errors: [] };
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { providers: [], errors: [`YUI_GATEWAY_CUSTOM não é um JSON válido: ${err.message}`] };
  }
  if (!Array.isArray(parsed)) return { providers: [], errors: ['YUI_GATEWAY_CUSTOM deve ser uma lista []'] };

  const providers = [];
  for (const [i, c] of parsed.entries()) {
    const id = String(c?.id ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) { errors.push(`provedor #${i + 1}: "id" inválido`); continue; }
    const endpoint = c.endpoint
      ? String(c.endpoint)
      : c.baseUrl ? `${String(c.baseUrl).replace(/\/+$/, '')}/chat/completions` : '';
    if (!/^https?:\/\//i.test(endpoint)) { errors.push(`${id}: informe "endpoint" ou "baseUrl" http(s)`); continue; }
    const models = (Array.isArray(c.models) ? c.models : []).map(String).filter(Boolean).map((m) => model(m, 'smart'));
    if (!models.length) { errors.push(`${id}: informe ao menos um modelo em "models"`); continue; }
    const keys = c.apiKeyEnv ? splitKeys(env[String(c.apiKeyEnv)]) : [];
    const anonymous = Boolean(c.anonymous);
    if (!keys.length && !anonymous) { errors.push(`${id}: sem chave em ${c.apiKeyEnv || '(apiKeyEnv)'}; ignorado`); continue; }
    providers.push({
      id, label: String(c.label || id), endpoint, keys, anonymous,
      noAuth: !keys.length, priority: Number.isFinite(c.priority) ? c.priority : 45, models,
    });
  }
  return { providers, errors };
}

/**
 * Lê o .env e devolve os provedores ativos, já ordenados por prioridade.
 * @returns {{ providers: Array, warnings: string[] }}
 */
export function loadProviders(env = process.env) {
  const warnings = [];
  const list = [];
  const add = (p) => { if (p.noAuth || p.keys.length) list.push({ headers: {}, anonymous: false, ...p }); };

  add({
    id: 'groq', label: 'Groq', priority: 10,
    endpoint: env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
    keys: splitKeys(env.GROQ_API_KEY, env.GROQ_API_KEYS),
    models: [model(env.GROQ_MODEL || 'openai/gpt-oss-120b', 'smart'), model('openai/gpt-oss-20b', 'fast')],
  });

  add({
    id: 'gemini', label: 'Google Gemini', priority: 20,
    endpoint: env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keys: splitKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY),
    models: [model(currentGeminiModel(env.GEMINI_MODEL, GEMINI_FAST), 'fast'), model(currentGeminiModel(env.GEMINI_MODEL_FALLBACK, GEMINI_SMART), 'smart')],
  });

  add({
    id: 'huggingface', label: 'Hugging Face', priority: 30,
    endpoint: env.HF_API_URL || 'https://router.huggingface.co/v1/chat/completions',
    keys: splitKeys(env.HF_TOKEN),
    models: [model(env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct', 'smart')],
  });

  add({
    id: 'openrouter', label: 'OpenRouter', priority: 40,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keys: splitKeys(env.OPENROUTER_API_KEY),
    models: csv(env.OPENROUTER_MODELS || 'meta-llama/llama-3.3-70b-instruct:free').map((m) => model(m, 'smart')),
  });

  const cfAccount = String(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const cfKeys = splitKeys(env.CLOUDFLARE_API_TOKEN);
  if (cfKeys.length && cfAccount) {
    add({
      id: 'cloudflare', label: 'Cloudflare Workers AI', priority: 50,
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/v1/chat/completions`,
      keys: cfKeys,
      models: [model(env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast', 'fast')],
    });
  }

  add({
    id: 'together', label: 'Together AI', priority: 60,
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    keys: splitKeys(env.TOGETHER_API_KEY),
    models: [model(env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'smart')],
  });

  // Gratuito e sem chave: público e anônimo, por isso fica por último e NUNCA
  // recebe conversas sensíveis (contexto pessoal).
  add({
    id: 'pollinations', label: 'Pollinations (grátis, anônimo)', priority: 90,
    endpoint: 'https://text.pollinations.ai/openai',
    keys: [], noAuth: true, anonymous: true,
    models: [model('openai', 'fast')],
  });

  for (const key of ['GEMINI_MODEL', 'GEMINI_MODEL_FALLBACK']) {
    if (isRetiredGeminiModel(env[key])) warnings.push(`${key}=${env[key]} foi aposentado pelo Google; usando o apelido atual (${key === 'GEMINI_MODEL' ? GEMINI_FAST : GEMINI_SMART}). Atualize o .env.`);
  }

  const custom = loadCustomProviders(env);
  warnings.push(...custom.errors);
  for (const p of custom.providers) add(p);

  // Desligar e reordenar por configuração
  const disabled = new Set(csv(env.YUI_GATEWAY_DISABLE).map((s) => s.toLowerCase()));
  let providers = list.filter((p) => !disabled.has(p.id));

  const preferred = csv(env.YUI_GATEWAY_PRIORITY).map((s) => s.toLowerCase());
  if (preferred.length) {
    providers = providers.map((p) => {
      const idx = preferred.indexOf(p.id);
      return idx === -1 ? p : { ...p, priority: idx };
    });
  }
  providers.sort((a, b) => a.priority - b.priority);
  return { providers, warnings };
}

/** Combos personalizados (YUI_GATEWAY_COMBOS): { "nome": ["provedor/modelo", ...] }. */
export function loadCombos(env = process.env) {
  const raw = String(env.YUI_GATEWAY_COMBOS ?? '').trim();
  if (!raw) return { combos: {}, errors: [] };
  try {
    const obj = JSON.parse(raw);
    const combos = {};
    for (const [name, list] of Object.entries(obj || {})) {
      if (/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(name) && Array.isArray(list)) combos[name.toLowerCase()] = list.map(String);
    }
    return { combos, errors: [] };
  } catch (err) {
    return { combos: {}, errors: [`YUI_GATEWAY_COMBOS não é um JSON válido: ${err.message}`] };
  }
}
