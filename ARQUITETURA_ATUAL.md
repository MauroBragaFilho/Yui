# ARQUITETURA_ATUAL — Yui (estado em 2026-11-05)

> Auditoria somente leitura. Nenhum código, banco ou memória foi alterado. Nenhum segredo é reproduzido; só nomes de variáveis.
> Legenda de evidência: `arquivo:linha` conforme lido pelos agentes de auditoria. Itens marcados **(não verificado)** não foram confirmados em execução.

## 1. Visão geral

Monorepo Node.js ESM (`"type":"module"`, ~57 mil linhas em `src/`), com **um único processo em produção** que sobe: cliente Discord, Yui API (HTTP), Yui Gateway (servidor de IA compatível com OpenAI), scheduler (node-cron) e serviços de TTS/STT. Há um app Expo/React Native (web + Android) em `apps/yui-app`.

```
Discord (DM/canais) ─► events/ + handlers/ ─► discordAdapter ─┐
                                                              ▼
App Expo (web/Android) ─► Yui API (:3939, 127.0.0.1) ─► YUI CORE (src/core)
                          (tailscale serve → HTTPS)       ├─ permissions (papel/canal/escopo)
                                                          ├─ memory (sql.js: pessoal / discord)
                                                          ├─ context (contexto por horas, off)
                                                          ├─ persona, audit, alerts
                                                          ├─ agent + tools (read-only por padrão)
                                                          ├─ dev (aba Código, ex-Jarvis)
                                                          └─ ai/manager ─► legacy-chain | gateway | openai-compatible
                                                                              │
                                              Yui Gateway (:20130) ◄──────────┘ ─► provedores de IA
Scheduler (node-cron) ─► engines GTAO / newswire / youtube / twitch ─► database/*.db (sql.js)
```

## 2. Mapa de módulos e responsabilidades

| Área | Caminho | Responsabilidade | Estado |
|---|---|---|---|
| Entrada | `src/index.js` (201 linhas) | Cria cliente Discord (`:118`), `startApi(client)` (`:169`), `startGatewayServer()` (`:172`) | Funcional |
| Core (fachada) | `src/core/index.js:1-12` | Exporta permissões, memória, audit, persona, ai, `runAgent`, `registerTool` | Funcional |
| Permissões | `src/core/permissions.js:40-93,127-152` | Papéis OWNER/TRUSTED/MEMBER/GUEST/BLOCKED, tipo de canal, escopo de memória, `YUI_READ_ONLY` (padrão ligado), deny por padrão | Funcional (`tests/test-core.js`) |
| Memória | `src/core/memory/{store,schemas}.js` | `remember/recall/forget/purge/admin`; bancos separados | Funcional |
| Contexto por horas | `src/core/context/contextStore.js` | Últimas falas por conversa, TTL por fala | Implementado, **desligado por padrão** |
| Persona | `src/core/persona.js`, `persona/*.md` | Tom por contexto (pessoal / assistente / pública) | Funcional |
| Auditoria | `src/core/audit.js` | JSONL append em `logs/core-audit.jsonl` | Funcional, rasa (ver segurança) |
| Agent | `src/core/agent/{agent,tools}.js` | 1 ferramenta por turno, confirmação 2 min, allowlists | Funcional, **só na API** |
| IA | `src/core/ai/manager.js` | 3 backends; pesquisa na web; regras de privacidade | Funcional |
| Gateway | `src/gateway/*` | Failover/rodízio de chaves entre provedores | Funcional (`tests/test-gateway.js`) |
| API | `src/core/api/{server,auth,admin,integrations,...}.js` | Login, sessões, `/v1/chat`, `/v1/agent`, painel admin, dev | Funcional |
| Código | `src/core/dev/*` | Laço de agente (12 passos), edição por SEARCH/REPLACE, terminal, aprovações | Funcional (modelo real não confirmado) |
| Discord | `src/discord/`, `src/events/`, `src/handlers/` (`llmHandler.js` 4302 linhas) | Comandos, menções, voz, rádio, downloads, GTA, moderação | Funcional |
| Engines | `src/engines/{gtao,newswire,twitch,youtube}` | Coleta e publicação | Funcional (testes com dublês) |
| Scheduler | `src/scheduler/scheduler.js` | Crons (newswire, diário, semanal, youtube, twitch, purge de memória 05:30 UTC) | Funcional |
| TTS/STT | `src/services/tts/*`, `src/services/sttService.js` | Voz da Yui na call | Estruturado e testado offline; call real **(não verificado)** |
| App | `apps/yui-app` | Chat, Memória, Status, Código, Conectar, Admin (Geral/IA/Guild/Ops) | Telas ligadas a `/v1/*` |
| Dados | `database/*.db` (sql.js), `secrets/*.json`, `src/data/*.json` | Persistência | Ver gaps |

## 3. Comunicação entre componentes

- **Discord → Core:** `llmHandler.js` usa `contextFromDiscord`, `buildMemoryBlock`, `captureFromUserText` (`llmHandler.js:2,2473,4012`). A resposta sai da cadeia própria `generateResponse` (`:1876+`), **não** pelo `runAgent` do Core.
- **App → Core:** `POST /v1/chat` e `/v1/agent` (`server.js:449-490`) → `buildMemoryBlock`, `ai.chatTurn`, `runAgent`.
- **Core → IA:** `AI_BACKEND` (padrão `legacy-chain`) → `import()` dinâmico de `llmHandler.js` (`manager.js:142,400`).
- **Gateway:** entra como `tryGateway` logo após o LM Studio na cadeia legada (`llmHandler.js:1885`) e como backend do Core (`manager.js:475`).
- **Acesso remoto:** API em `127.0.0.1`; `tailscale serve --bg --https=3939 http://127.0.0.1:3939`; `funnel` proibido (`OPERACAO.md:51-71`).

## 4. Dependências

- **Externas (runtime):** discord.js, @discordjs/voice, sql.js, axios, cheerio, puppeteer, node-cron, winston, msedge-tts, @gradio/client, @noble/ciphers.
- **Ferramentas externas:** yt-dlp, spotdl (`.venv-spotdl`), deemix (`.venv-deemix`), LM Studio (IA local), Tailscale.
- **Serviços de IA em nuvem:** Groq, Gemini, Hugging Face, OpenRouter, Cloudflare, Together, Pollinations (anônimo), Horde (anônimo).
- **Internas:** `core/ai/manager` depende de `handlers/{researchAgent,searchIntent,llmSafety}` (`manager.js:5-12`) — o Core importa módulos de `handlers/`.

## 5. Independência do Core

| Pergunta | Resposta |
|---|---|
| `src/core` importa `discord.js`? | Quase não; só `api/server.js` recebe o `client` |
| Core roda sem Discord? | **Parcialmente.** Com `AI_BACKEND=gateway` ou `openai-compatible`, sim. Com o padrão `legacy-chain`, arrasta `llmHandler.js` (discord.js, TTS, rádio, GTA) |
| Há modo de teste sem Discord? | `npm run dev:api` (`scripts/dev-api.mjs`), IA simulada **(não executado)** |
| Processo único | Sim: bot, API, Gateway e scheduler no mesmo processo (queda de um derruba todos) |

## 6. Integração entre interfaces

| Interface | Situação |
|---|---|
| Discord | Completa, mas com pipeline próprio (`llmHandler`) e permissões paralelas ao Agent do Core |
| App web/Android | Telas reais; Android **nunca foi buildado** (sem pasta `android/`, só `app.json`); sem APK, notificações, streaming |
| Desktop | **Não existe neste repositório.** A documentação cita "Yui Desktop" (Electron) em `D:\Projetos\Projeto Jarvis\Yui Desktop` (fora do repo, não auditada). Faltam aprovações nativas do Windows |
| Voz | Módulo TTS maduro; STT existe; teste em call real pendente |
| Contexto compartilhado entre interfaces | Não. Contexto por horas é por canal (`dm:<id>`/`ch:<canal>:u:<id>`); a API usa `Map` em RAM. Só a memória de longo prazo é por `userId`/escopo |

## 7. Duplicações, acoplamentos e gargalos

1. **Duas cadeias de provedores de IA** (`llmHandler.js:1319-1900` e `gateway/providers.js`); o próprio `manager.js:28-30` admite a extração como "evolução futura".
2. **Dois sistemas de política** não relacionados: `permissions.js` (`access`+`confirm`) e `dev/policy.js` (`allow/ask/deny`).
3. **Três mecanismos de histórico:** `contextStore`, `Map` em RAM da API (`server.js:203-204`), histórico por canal do `llmHandler`; mais `historico.txt` sem retenção.
4. **Agent do Core só na API;** o Discord tem ferramentas e MCP internos próprios.
5. **`llmHandler.js` monolítico** (4302 linhas).
6. **Persistência sql.js em RAM:** cada escrita regrava o arquivo inteiro de forma síncrona (`db.js:151-155`); `remember` fora de transação ≈ 3 regravações; `touchUser` regrava por mensagem (`store.js:50-59`).
7. **Dois processos sobre a mesma pasta de bancos perdem escritas** (sem lock de arquivo).
8. **Config duplicada:** `src/config.js` e `src/config/{index.js,config.json,constants.js}`.
9. **Um `activeRun` global** no módulo dev (`dev/index.js:130`).

## 8. Infraestrutura atual

- **Execução:** PC Windows. `Yui.bat` (menu), `setup.ps1`. Não há serviço, tarefa agendada nem watchdog da Yui no Windows (só `scripts/yui.service` para Linux e `discloud.config` da hospedagem antiga).
- **Health:** `/v1/health` público (expõe `backends` e flags). Não há reinício automático se cair.
- **Tailscale:** só documentação; nada automatiza ou verifica o `tailscale serve`.
- **Logs:** `logs/app-AAAA-MM-DD.log` diários sem política de retenção visível; auditoria em `logs/core-audit.jsonl`.
- **Não versionados no momento:** `scripts/instalar-ssh.ps1`, `instalar-tudo-offline.ps1`, `otimizar-windows.ps1`, `scripts/modpack/` (utilidades de PC/Minecraft, sem relação com o Core).

## 9. Testes executados nesta auditoria

| Comando | Resultado |
|---|---|
| `node tests/test-core.js` | 21 testes OK (banco e auditoria em diretório temporário) |
| `npm test` em `apps/yui-app` | 23 aprovados, 0 falhas |
| Demais (`test-core-api`, `test-gateway`, `test-readonly`, `typecheck`, testes TTS/engines) | **Não executados** (incerteza sobre dependência de rede); os "2.900 verificações" da documentação são afirmação dela, não reconfirmada |
