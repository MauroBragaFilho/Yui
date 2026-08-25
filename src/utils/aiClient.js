import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Cliente genérico compatível com a API "OpenAI-style" de chat completions
 * (POST {baseURL}/chat/completions). Funciona com:
 *   - LM Studio rodando localmente (ex: http://localhost:1234/v1)
 *   - OpenAI oficial (https://api.openai.com/v1)
 *   - Qualquer provedor em nuvem compatível com o formato OpenAI
 *     (ex: OpenRouter, Groq, Together AI, Azure OpenAI com adaptação, etc.)
 *
 * Tudo é configurável via .env — trocar de provedor não exige mudar código,
 * só as variáveis AI_BASE_URL / AI_API_KEY / AI_MODEL.
 */

function isConfigured() {
  return Boolean(config.ai?.baseUrl);
}

/**
 * Envia uma lista de mensagens no formato OpenAI ([{role, content}]) e
 * retorna o texto da resposta do assistente.
 */
export async function chatCompletion(messages, options = {}) {
  if (!isConfigured()) {
    throw new Error(
      'Integração de IA não configurada. Defina AI_BASE_URL (e AI_API_KEY, se necessário) no .env.'
    );
  }

  const baseUrl = config.ai.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  // LM Studio local geralmente não exige chave; provedores em nuvem exigem.
  if (config.ai.apiKey) {
    headers.Authorization = `Bearer ${config.ai.apiKey}`;
  }

  try {
    const response = await axios.post(
      url,
      {
        model: config.ai.model || 'local-model',
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? (config.ai?.maxTokens || 1500),
      },
      { headers, timeout: options.timeout ?? 30000 }
    );

    let content = response.data?.choices?.[0]?.message?.content;
    const finishReason = response.data?.choices?.[0]?.finish_reason;

    if (!content || typeof content !== 'string') {
      if (finishReason === 'length') {
        throw new Error(
          'O modelo esgotou o limite de tokens (max_tokens) durante o raciocínio. Aumente AI_MAX_TOKENS no .env.'
        );
      }
      throw new Error('Resposta da IA veio vazia ou em formato inesperado.');
    }

    // Se o modelo incluir tags de raciocínio (<think>...</think>), remove para exibir apenas a resposta final
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (!content) {
      throw new Error('Resposta da IA veio vazia após filtrar tags internas de raciocínio.');
    }

    return content;
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.message;
    logger.error(`[AIClient] Falha ao consultar ${baseUrl}: ${detail}`);
    throw new Error(`Falha ao consultar a IA: ${detail}`);
  }
}

export const aiClient = { chatCompletion, isConfigured };
