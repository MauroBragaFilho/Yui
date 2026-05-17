# ⚙️ Configuração, Governança e Multi-Token

Este documento aborda a arquitetura de configuração da Hikari, focando na resiliência de API e na escalabilidade de permissões de proprietário (Multi-Owner).

---

## 📂 Sumário

1. [🔑 1. Arquitetura Multi-Token](#-1-arquitetura-multi-token)
2. [👑 2. Sistema de Governança (Multi-Owner)](#-2-sistema-de-governança-multi-owner)
3. [🛠️ 3. Mapeamento de Configurações](#-3-mapeamento-de-configurações-srcconfigindexjs)
4. [💡 Dicas de Configuração Avançada](#-dicas-de-configuração-avançada)

---

## 🔑 1. Arquitetura Multi-Token

Para contornar limites de taxa (Rate Limits) impostos por provedores como Google e Stability, implementamos um sistema de **Key Rotation** no core do bot.

### Provedores Suportados para Rotação:
- **Gemini (LLM):** Definir no `.env` como `GEMINI_API_KEY=key1,key2,key3`.
  - **Lógica:** Implementada como `Ordered Retry` (Tenta a 1ª, se falhar por 429 ou erro de quota, tenta a 2ª).
- **Stability AI (Imagens):** Definir como `STABILITY_API_KEY=key1,key2`.
  - **Lógica:** Implementada como `Random Load Balancing` (Escolhe uma das chaves aleatoriamente a cada requisição para distribuir o consumo de créditos).

---

## 👑 2. Sistema de Governança (Multi-Owner)

Diferente de bots legados que suportam apenas um proprietário, a Hikari utiliza uma lista de IDs para validação de privilégios administrativos.

### Configuração:
No `.env`, preencha `OWNER_ID` com os IDs dos usuários separados por vírgula.
```env
OWNER_ID=593372065730396160,123456789012345678
```

### Implementação Técnica:
No código (`src/config/index.js`), o método `isOwner(userId)` é utilizado para verificar se o ID faz parte do array `ownerIds`. Se um comando for global (restrito), apenas o retorno `true` deste método permitirá a execução.

---

## 🛠️ 3. Mapeamento de Configurações (`src/config/index.js`)

Centralizamos todas as constantes globais para facilitar a manutenção. Abaixo, os campos principais:

| Campo | Fonte (.env) | Função |
| :--- | :--- | :--- |
| `discordToken` | `DISCORD_TOKEN` | Credencial de conexão Gateway do Discord. |
| `geminiModel` | `GEMINI_MODEL` | Identificador do modelo base (Ex: `gemini-1.5-flash`). |
| `systemPrompt` | `SYSTEM_PROMPT` | O Core Context que define o comportamento da IA. |
| `requireTos` | `REQUIRE_TOS` | Se `true`, exige aceitação dos termos ao entrar em novos servidores. |
| `saveHistory` | `SAVE_HISTORY` | Se `true`, salva logs de prompt e resposta no arquivo `historico.txt`. |
| `localLlmUrl` | `LOCAL_LLM_URL` | Endpoint para integração com LM Studio ou Ollama. |
| `defaultAutoMod` | `DEFAULT_AUTOMOD` | Habilita ou desabilita o AutoMod por padrão para novos servidores (Padrão: `true`). |
| `automodMode` | `AUTOMOD_MODE` | Define o modo de operação do AutoMod (`off`, `trigger`, `mcp`, `both`). |

---

## 💡 Dicas de Configuração Avançada

- 💡 **Rate Limiting Local:** Se estiver usando modelos locais via `LOCAL_LLM_URL`, você pode configurar o `timeout` dentro do objeto `providerSettings` no `llmHandler.js` para evitar travamentos de fila.
- 💡 **Segurança de Logs:** A `LOG_WEBHOOK_URL` captura `stderr` e `stdout`. Mantenha esse webhook em um canal privado de alta segurança, pois ele exibe traços de erro que podem conter detalhes internos da execução.
- 💡 **Retrocompatibilidade:** O campo `ownerId` (singular) no objeto config sempre apontará para o primeiro ID da lista, garantindo que módulos legados continuem funcionando.

---
[🏠 Voltar ao Menu Principal](../README.md)
