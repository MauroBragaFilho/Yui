# 🔑 Guia de Variáveis de Ambiente e Configuração / Environment & Config Guide

Este guia explica cada entrada do arquivo `.env` e as configurações internas da Yui, com os links necessários para obter as chaves de API.

---

## 📂 Sumário

1. [🌐 Configurações Obrigatórias](#-configurações-obrigatórias)
2. [🤖 Chaves de API de IA](#-chaves-de-api-de-ia)
3. [🌍 Provedores e URLs](#-provedores-e-urls)
4. [👑 Governança e Preferências](#-governança-e-preferências)

---

## 🌐 Configurações Obrigatórias

| Variável            | Descrição                              | Onde Obter                                                              |
| :------------------ | :------------------------------------- | :---------------------------------------------------------------------- |
| `DISCORD_TOKEN`     | Token de acesso do seu bot no Discord. | [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CLIENT_ID` | ID da aplicação do seu bot.            | [Discord Developer Portal](https://discord.com/developers/applications) |

---

## 🤖 Chaves de API de IA

### 🧠 Modelos de Linguagem (LLM)

- **`GEMINI_API_KEY`**: Chave principal para o motor da Yui. Suporta rotação (ex: `key1,key2`).
  - 🔗 **Obter em:** [Google AI Studio](https://aistudio.google.com/app/apikey)
- **`HF_TOKEN`**: Token para modelos do HuggingFace (como o FLUX para imagens ou modelos de chat).
  - 🔗 **Obter em:** [Hugging Face Settings](https://huggingface.co/settings/tokens)
- **`LM_STUDIO_API_KEY`**: Opcional. Use se estiver rodando um modelo local via [LM Studio](https://lmstudio.ai/).

### 🎨 Geração de Imagens

- **`STABILITY_API_KEY`**: Para geração de imagens de ultra qualidade (SDXL/Stable Diffusion).
  - 🔗 **Obter em:** [Stability AI Platform](https://platform.stability.ai/account/keys)
- **`HORDE_API_KEY`**: Chave para a rede AI Horde (descentralizada). Use `0000000000` para uso anônimo com menor prioridade.
  - 🔗 **Obter em:** [AI Horde Register](https://aihorde.net/register)

### 🔍 Pesquisa e Outros

- **`BRAVE_API_KEY`**: Utilizada para que a IA possa pesquisar na internet em tempo real.
  - 🔗 **Obter em:** [Brave Search API](https://api.search.brave.com/app/dashboard)

- **`DEEZER_ARL`** (ou `DEEMIX_ARL`): Token de autenticação ARL da sua conta Deezer para permitir o download de músicas em alta qualidade via `deemix`.
  - 🔗 **Obter em:** Cookie `arl` nas ferramentas de desenvolvedor do navegador em [Deezer.com](https://www.deezer.com).

---

## 🌍 Provedores e URLs

- **`LOCAL_LLM_URL`**: Endpoint do seu servidor local (LM Studio / Ollama). Padrão: `http://localhost:1234/v1/chat/completions`.
- **`GEMINI_URL`**: URL da API do Gemini (OpenAI compatible).
- **`HF_API_URL`**: Endpoint para inferência do HuggingFace.
- **`LOG_WEBHOOK_URL`**: URL de um webhook do Discord para receber logs de erro e status direto no seu servidor.

---

## 👑 Governança e Preferências

- **`OWNER_ID`**: Seu ID de usuário do Discord (ou vários separados por vírgula). Esse ID é o dono do bot, e só ele poderá usar comandos com flag Dono.
- **`PREFIX`**: Prefixo para comandos legados (se houver). Padrão: `@`.
- **`BOT_NAME`**: O nome que a Yui reconhecerá como sendo dela.
- **`REQUIRE_TOS`**: Se `true`, novos servidores precisam aceitar os termos de uso antes de usar o bot.
- **`SAVE_HISTORY`**: Salva o histórico de mensagens em `src/data/historico.txt` para depuração.

---

## 💡 Dicas de Especialista

- 💡 **Rotação de Chaves:** No campo `GEMINI_API_KEY`, você pode colocar várias chaves separadas por vírgula. Isso evita que o bot pare de responder caso uma das chaves atinja o limite de uso gratuito.
- 💡 **Economia de Créditos:** Utilize o `LOCAL_LLM_URL` com LM Studio ou Ollama para processar conversas sem custo de tokens, ideal para servidores privados ou de teste.
- 💡 **Segurança de Webhooks:** Nunca compartilhe a `LOG_WEBHOOK_URL`. Ela contém logs de sistema que podem expor detalhes da sua infraestrutura. Mantenha-a em um canal trancado.
- 💡 **ID do Dono:** Certifique-se de que o primeiro ID em `OWNER_ID` seja o seu. Alguns comandos de sistema priorizam o "Dono Primário" para ações críticas.

---

[🏠 Voltar ao Menu Principal](../README.md)
