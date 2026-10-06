import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { buildPersonaPrompt } from '../persona.js';

/**
 * AI Manager — interface única de IA do Yui Core.
 *
 * O Core nunca chama um provedor diretamente: ele pede `chat()` ao Manager,
 * que delega a um backend registrado. Trocar de modelo (nuvem → LM Studio →
 * llama.cpp → OmniRoute) é registrar/selecionar outro backend, sem tocar no Core.
 *
 * Contrato de um backend:
 *   {
 *     name: string,
 *     local: boolean,                       // o modelo roda na máquina do dono?
 *     chat({ prompt, system, history, ctx, memoryBlock }) => Promise<string>
 *   }
 *
 * Backends embutidos:
 *  - "legacy-chain" (padrão): a cadeia de provedores que já existe no
 *    llmHandler.js (LM Studio → HF → Groq → Gemini → Cloudflare → ...).
 *    Carregada sob demanda, para o Core não depender do Discord na importação.
 *    Extrair esses provedores para backends independentes é evolução futura.
 *  - "openai-compatible": qualquer endpoint /chat/completions (ver abaixo).
 *
 * Seleção: AI_BACKEND=<nome> (padrão: legacy-chain).
 */

const backends = new Map();
let activeName = null;

export function registerBackend(backend, { activate = false } = {}) {
  if (!backend?.name || typeof backend.chat !== 'function') {
    throw new Error('Backend inválido: precisa de { name, chat() }.');
  }
  backends.set(backend.name, { local: false, ...backend });
  if (activate || !activeName) activeName = backend.name;
}

export function setActiveBackend(name) {
  if (!backends.has(name)) throw new Error(`Backend desconhecido: ${name}`);
  activeName = name;
}

export function listBackends() {
  return [...backends.values()].map((b) => ({ name: b.name, local: b.local, active: b.name === activeName }));
}

/**
 * Pede uma resposta à IA ativa.
 *
 * `AI_PRIVATE_LOCAL_ONLY=true` faz o Manager RECUSAR enviar contexto de
 * memória pessoal para um backend que não seja local (pronto para quando
 * houver IA local; hoje o padrão é false, pois a nuvem é permitida).
 */
export async function chat({ prompt, system = '', history = [], ctx, memoryBlock = '' }) {
  const backend = backends.get(activeName);
  if (!backend) throw new Error('Nenhum backend de IA registrado.');

  if (
    String(process.env.AI_PRIVATE_LOCAL_ONLY || 'false').toLowerCase() === 'true' &&
    ctx?.memoryScope === 'personal' &&
    !backend.local
  ) {
    throw new Error('Contexto pessoal bloqueado: AI_PRIVATE_LOCAL_ONLY exige backend local.');
  }

  // Personalidade decidida pelo backend a partir do contexto (papel + canal).
  const persona = system || buildPersonaPrompt(ctx);

  const started = Date.now();
  const text = await backend.chat({ prompt, system: persona, history, ctx, memoryBlock });
  logger.info(`[AI] backend=${backend.name} ${Date.now() - started}ms`);
  return text;
}

// ───────────────────────── Backends embutidos ─────────────────────────

function registerLegacyChain() {
  registerBackend({
    name: 'legacy-chain',
    local: false,
    async chat({ prompt, system, history, ctx, memoryBlock }) {
      const { generateResponse } = await import('../../handlers/llmHandler.js');
      // A cadeia legada guarda histórico por canal do Discord, que não existe
      // aqui: o histórico da conversa vai no próprio prompt.
      const transcript = history.length
        ? history.map((m) => `${m.role === 'assistant' ? 'Você (Yui)' : 'Usuário'}: ${m.content}`).join('\n')
        : '';
      const finalPrompt = transcript
        ? `[CONVERSA ATÉ AGORA]\n${transcript}\n\n[MENSAGEM ATUAL DO USUÁRIO]\n${prompt}`
        : prompt;
      return generateResponse(finalPrompt, `api:${ctx?.userId || 'anon'}`, {
        userId: ctx?.userId,
        memoryBlock,
        persona: system || undefined,
        allowSearch: false,
        disableTools: true,
        guildId: null,
      });
    },
  });
}

/**
 * Backend "openai-compatible": LM Studio, llama.cpp server, OmniRoute,
 * OpenRouter, Groq... Configurado por AI_BASE_URL, AI_API_KEY e AI_MODEL.
 *
 * AI_BASE_LOCAL=true deve ser marcado SOMENTE se o modelo realmente roda na
 * sua máquina. Um gateway local (ex.: OmniRoute) que encaminha para
 * provedores de nuvem NÃO é local, e por isso não é inferido pelo endereço.
 */
function registerOpenAiCompatible() {
  const baseUrl = (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return;
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  registerBackend({
    name: 'openai-compatible',
    local: String(process.env.AI_BASE_LOCAL || 'false').toLowerCase() === 'true',
    async chat({ prompt, system, history, memoryBlock }) {
      const persona = system || process.env.AI_SYSTEM_PROMPT ||
        'Você é a Yui, uma assistente pessoal prestativa, direta e simpática. Responda em português do Brasil.';
      const messages = [
        { role: 'system', content: persona + (memoryBlock || '') },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ];
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.AI_API_KEY) headers.Authorization = `Bearer ${process.env.AI_API_KEY}`;
      const { data } = await axios.post(
        endpoint,
        {
          model: process.env.AI_MODEL || undefined,
          messages,
          max_tokens: parseInt(process.env.AI_MAX_TOKENS || '1500', 10),
        },
        { headers, timeout: 90_000 }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (!text || !String(text).trim()) throw new Error('Resposta vazia do backend openai-compatible');
      return String(text).trim();
    },
  });
}

/** (Re)carrega os backends embutidos e aplica AI_BACKEND. Útil em testes. */
export function initAiManager() {
  backends.clear();
  activeName = null;
  registerLegacyChain();
  registerOpenAiCompatible();
  const wanted = (process.env.AI_BACKEND || '').trim();
  if (wanted) {
    if (backends.has(wanted)) activeName = wanted;
    else logger.warn(`[AI] AI_BACKEND="${wanted}" não encontrado; mantendo "${activeName}".`);
  }
}

initAiManager();
