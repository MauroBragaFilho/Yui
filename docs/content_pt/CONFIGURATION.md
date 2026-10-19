# ⚙️ Configuração, Governança e Rodízio de Chaves

Como a configuração da Yui é montada em `src/config/index.js`, como funcionam o rodízio de chaves e os donos. Para a lista de todas as variáveis, veja [ENVIRONMENT.md](ENVIRONMENT.md).

---

## 📂 Sumário

1. [Rodízio de chaves](#-1-rodízio-de-chaves)
2. [Governança (vários donos)](#-2-governança-vários-donos)
3. [Mapeamento de configurações](#-3-mapeamento-de-configurações)
4. [Pesquisa na web](#-4-pesquisa-na-web)
5. [Dicas](#-dicas)

---

## 🔑 1. Rodízio de chaves

Para contornar limites de taxa (Google, Stability), as chaves aceitam **várias entradas separadas por vírgula**.

- **Gemini:** `GEMINI_API_KEYS=key1,key2` ou `GEMINI_API_KEY=key1,key2` (os dois nomes são lidos e somados, sem duplicar). Tenta em ordem; em `429`/cota passa à próxima chave.
  - Os modelos configurados (`GEMINI_MODEL`, `GEMINI_MODEL_FALLBACK`) são validados: modelos **aposentados** (`gemini-1.5-*`, `gemini-2.0-*`...) são trocados por `gemini-flash-lite-latest` / `gemini-flash-latest` (veja `src/utils/geminiModels.js`).
- **Stability AI:** `STABILITY_API_KEYS=key1,key2` ou `STABILITY_API_KEY=...`. A chave é **sorteada** a cada requisição (`config.getStabilityKey()`) para distribuir o consumo de créditos.
- **RAWG.io:** `RAWG_API_KEY=sua_chave` ([rawg.io/apidocs](https://rawg.io/apidocs)) alimenta `check_game_info`. Sem ela, a Yui busca nota/sinopse via Steam e tempo de jogo via HowLongToBeat, de forma reduzida.
- **Yui Gateway:** faz seu próprio rodízio de chaves entre provedores, com descanso progressivo em falhas. Veja [Gateway](GATEWAY.md).

---

## 👑 2. Governança (vários donos)

A Yui aceita mais de um dono:

```env
OWNER_ID=593372065730396160
OWNER_IDS=123456789012345678,987654321098765432
```

`OWNER_ID` é o **dono primário**; `OWNER_IDS` lista os demais (ambos são somados em `config.ownerIds`). O método `isOwner(userId)` decide quem pode usar comandos restritos, e `config.ownerId` (singular) aponta sempre para o primeiro, por compatibilidade.

No **Yui Core**, o papel `OWNER` vem de `YUI_OWNER_ID` (ou `OWNER_ID`). O Core, não o cliente nem o modelo de IA, decide as permissões; veja [Assistente pessoal](ASSISTENTE_PESSOAL.md).

---

## 🛠️ 3. Mapeamento de configurações

Campos principais de `src/config/index.js`:

| Campo | Fonte (.env) | Função |
| :--- | :--- | :--- |
| `discordToken` / `clientId` | `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` | Conexão com o Discord |
| `ownerIds` | `OWNER_ID`, `OWNER_IDS` | Donos do bot |
| `requireTos` | `REQUIRE_TOS` | Exige aceite dos termos ao entrar em novos servidores |
| `prefix` | `COMMAND_PREFIX` | Prefixo de comandos de texto (padrão `+yui`) |
| `geminiApiKeys` / `geminiModel` | `GEMINI_API_KEYS`, `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini com rodízio e modelos validados |
| `localLlmUrl` | `LOCAL_LLM_URL` | LM Studio / Ollama |
| `ai.systemPrompt` / `ai.botName` | `AI_SYSTEM_PROMPT`, `AI_BOT_NAME` | Comportamento e nome da IA |
| `gtaWeekly` | `GTA_WEEKLY_ENABLED`, `GTA_WEEKLY_INTERVAL_MINUTES` | Evento semanal |
| `newswire` | `NEWSWIRE_ENABLED`, `NEWSWIRE_INTERVAL_MINUTES` | Notícias (desligado por padrão) |
| `youtube` / `twitch` | `YOUTUBE_*`, `TWITCH_*` | Avisos |

> O AutoMod **não** é mais configurado por `.env`: cada servidor escolhe seu modo (`off`, `trigger`, `mcp`, `both`) pelos comandos de moderação ou pelo painel (**Admin → Servidores**). As antigas `DEFAULT_AUTOMOD`, `AUTOMOD_MODE` e `SAVE_HISTORY` não são mais lidas.

---

## 🔎 4. Pesquisa na web

A pesquisa na web é conduzida por um **agente de pesquisa** (código, não o modelo; veja [Recursos](FEATURES.md#-pesquisa-na-web)) e se configura só por variáveis de ambiente, sem campo no `config.json`. Sem nenhuma linha no `.env` valem os padrões do código; o `.env_example` traz todas, comentadas, e a tabela completa está em [Variáveis de ambiente](ENVIRONMENT.md#-agente-de-pesquisa).

| Para... | Use |
| :--- | :--- |
| Desligar o agente e voltar ao jeito antigo da ferramenta `search_web` | `YUI_RESEARCH_ENABLED=false` |
| Só observar no log o que a guarda de promessa trocaria | `YUI_RESEARCH_GUARD=observe` (`on` troca; `off` desliga) |
| Pesquisar o pedido explícito sem esperar a primeira resposta da IA | `YUI_RESEARCH_PRE_ROUTE=true` (padrão `false`) |
| Liberar a pesquisa em conversa privada (a DM de qualquer pessoa, o dono em canal privado e o app) | `YUI_PRIVATE_SEARCH=owner` (só o dono) ou `all` (qualquer pessoa); padrão `off` |
| Mudar os limites por hora | `YUI_SEARCH_USER_PER_HOUR` (5 por pessoa) e `YUI_SEARCH_GLOBAL_PER_HOUR` (20 no total) |
| Mudar passos, páginas lidas e prazo do agente | `YUI_RESEARCH_MAX_STEPS` (2), `YUI_RESEARCH_PAGES` (2) e `YUI_RESEARCH_DEADLINE_MS` (60000) |

> ⚠️ Com `YUI_PRIVATE_SEARCH=owner` ou `all`, o texto do pedido sai do seu PC para buscadores de terceiros (Tavily, Brave, DuckDuckGo, Bing). Em `all` isso vale para qualquer pessoa que use uma conversa privada da Yui, e os Termos de Uso não foram atualizados para citar isso (veja o [aviso de privacidade](ENVIRONMENT.md#-privacidade-da-pesquisa-em-conversa-privada)). Para ligar o agente aos poucos (observar, depois ativar a pré-rota), siga o passo a passo em [Como ligar aos poucos](ENVIRONMENT.md#-como-ligar-aos-poucos).

---

## 💡 Dicas

- **Modelos locais:** com `LOCAL_LLM_URL` (LM Studio/Ollama) as conversas não gastam tokens; o `timeout` fica em `providerSettings`, no `llmHandler.js`.
- **Retrocompatibilidade:** `ownerId` (singular) sempre aponta para o primeiro dono.
- **Testes:** `npm run test:config` valida o rodízio de chaves e a normalização dos modelos Gemini.

---
[🏠 Voltar ao Menu Principal](../README.md)
