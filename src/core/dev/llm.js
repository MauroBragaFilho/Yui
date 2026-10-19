/**
 * IA do módulo de código: LM Studio (local) primeiro e, se ele não estiver ligado
 * ou falhar, o Yui Gateway em processo (Groq, Gemini, OmniRoute...).
 *
 * O código do projeto é tratado como conteúdo SENSÍVEL: nunca vai para provedores
 * anônimos (ex.: Pollinations). Esta é a mesma regra das conversas pessoais.
 */

export class DevLlmError extends Error {}

const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, 160);

function lmStudioUrl(env) {
  const raw = String(env.LOCAL_LLM_URL || env.AI_BASE_URL || 'http://127.0.0.1:1234/v1').trim().replace(/\/+$/, '');
  return raw.endsWith('/chat/completions') ? raw : `${raw}/chat/completions`;
}

export function createDevLlm({ env = process.env, fetchImpl = (...args) => fetch(...args), getGateway = async () => (await import('../../gateway/index.js')).getGateway() } = {}) {
  async function viaLmStudio(messages, { maxTokens, temperature, signal }) {
    const headers = { 'Content-Type': 'application/json' };
    const key = env.LM_STUDIO_API_KEY || env.AI_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const timeout = AbortSignal.timeout(180_000);
    const res = await fetchImpl(lmStudioUrl(env), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: env.LOCAL_LLM_MODEL || env.AI_MODEL || 'local-model', messages, max_tokens: maxTokens, temperature }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new DevLlmError(`LM Studio: HTTP ${res.status} ${clip(await res.text().catch(() => ''))}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new DevLlmError('LM Studio: resposta vazia');
    return { text, provider: 'lmstudio', model: data.model || '' };
  }

  async function viaGateway(messages, { maxTokens, temperature }) {
    const gateway = await getGateway();
    if (!gateway.hasTargets()) throw new DevLlmError('Yui Gateway: nenhum provedor configurado');
    const result = await gateway.chat({ model: 'auto', messages, max_tokens: maxTokens, temperature }, { sensitive: true });
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new DevLlmError('Yui Gateway: resposta vazia');
    return { text, provider: result.x_gateway?.provider || 'gateway', model: result.x_gateway?.model || '' };
  }

  /**
   * @param {{ messages: Array, temperature?: number, maxTokens?: number }} request
   * @returns {Promise<{ text: string, provider: string, model: string }>}
   */
  async function chat(request, { signal = null } = {}) {
    const opts = { maxTokens: request.maxTokens ?? 4096, temperature: request.temperature ?? 0.3, signal };
    const attempts = [];
    for (const attempt of [viaLmStudio, viaGateway]) {
      if (signal?.aborted) throw new DevLlmError('Cancelado.');
      try {
        return await attempt(request.messages, opts);
      } catch (err) {
        if (signal?.aborted) throw new DevLlmError('Cancelado.');
        attempts.push(err instanceof DevLlmError ? err.message : `${attempt === viaLmStudio ? 'LM Studio' : 'Yui Gateway'}: ${clip(err.cause?.code || err.message)}`);
      }
    }
    throw new DevLlmError(`Nenhuma IA respondeu: ${attempts.join(' | ')}`);
  }

  return { chat };
}
