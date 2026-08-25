# Provedores de IA Gratuitos Compatíveis com a API OpenAI

Este guia contém as opções de provedores de nuvem que oferecem endpoints compatíveis com o padrão OpenAI (`/v1/chat/completions`) com planos ou modelos **100% gratuitos**.

---

## 1. Groq (Recomendado — Ultra Rápido)
- **Site:** [https://console.groq.com/](https://console.groq.com/)
- **Custo:** Camada gratuita generosa (sem necessidade de cartão de crédito).
- **Modelos Populares:** `openai/gpt-oss-120b` (melhor inteligência), `openai/gpt-oss-20b` (rápido e leve), `groq/compound-mini`, `qwen/qwen3.6-27b`.
- **Configuração no `.env`:**
  ```env
  AI_BASE_URL=https://api.groq.com/openai/v1
  AI_API_KEY=gsk_sua_chave_groq_aqui
  AI_MODEL=openai/gpt-oss-120b
  AI_MAX_TOKENS=1500
  ```

---

## 2. OpenRouter (Mais Variedade de Modelos Gratuitos)
- **Site:** [https://openrouter.ai/](https://openrouter.ai/)
- **Custo:** Modelos com sufixo `:free` são 100% gratuitos.
- **Modelos Populares:** `meta-llama/llama-3.3-70b-instruct:free`, `deepseek/deepseek-r1:free`, `google/gemini-2.0-flash-exp:free`.
- **Configuração no `.env`:**
  ```env
  AI_BASE_URL=https://openrouter.ai/api/v1
  AI_API_KEY=sk-or-v1-sua_chave_aqui
  AI_MODEL=meta-llama/llama-3.3-70b-instruct:free
  ```

---

## 3. Google AI Studio (Gemini com Endpoint OpenAI)
- **Site:** [https://aistudio.google.com/](https://aistudio.google.com/)
- **Custo:** Gratuito (com limite de requisições por minuto).
- **Modelos Populares:** `gemini-1.5-flash`, `gemini-2.0-flash`.
- **Configuração no `.env`:**
  ```env
  AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
  AI_API_KEY=AIzaSy_sua_chave_google_aqui
  AI_MODEL=gemini-1.5-flash
  ```

---

## 4. Together AI & Mistral AI
- **Sites:** [Together AI](https://together.ai/) | [Mistral Console](https://console.mistral.ai/)
- **Custo:** Oferecem créditos gratuitos de teste inicial (trial).
- **Configuração no `.env` (Together AI):**
  ```env
  AI_BASE_URL=https://api.together.xyz/v1
  AI_API_KEY=sua_chave_together_aqui
  AI_MODEL=meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo
  ```
