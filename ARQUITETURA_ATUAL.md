# ARQUITETURA_ATUAL — Yui (estado em 2026-11-05)

> Auditoria somente leitura. Nenhum código, banco ou memória foi alterado. Nenhum segredo é reproduzido; só nomes de variáveis.
> Legenda de evidência: `arquivo:linha` conforme lido pelos agentes de auditoria. Itens marcados **(não verificado)** não foram confirmados em execução.
> **Atualizado em 10/11/2026** contra a árvore de trabalho (inclui mudanças ainda não commitadas): produção no notebook (§8), backup e auditoria encadeada (Fase 0), DM só do dono, pedidos por conversa (Portas I, B, N/R), proteção de reconexão do Discord. Contagens de linhas e `arquivo:linha` revisados; o que é desta revisão traz a data ou a evidência ao lado.

## 1. Visão geral

Monorepo Node.js ESM (`"type":"module"`, ~59 mil linhas em `src/`: 59.179 em `.js`/`.mjs` em 10/11/2026, eram ~57 mil em 05/11), com **um único processo em produção** que sobe: cliente Discord, Yui API (HTTP), Yui Gateway (servidor de IA compatível com OpenAI), scheduler (node-cron) e serviços de TTS/STT. Desde 03/11/2026 esse processo roda num notebook dedicado (§8). Há um app Expo/React Native (web + Android) em `apps/yui-app`.

```
Discord (DM/canais) ─► events/ + handlers/ ─► discordAdapter ─┐
                                                              ▼
App Expo (web/Android) ─► Yui API (:3939, 127.0.0.1) ─► YUI CORE (src/core)
                          (tailscale serve → HTTPS)       ├─ permissions (papel/canal/escopo)
                                                          ├─ memory (sql.js: pessoal / discord) + backup cifrado
                                                          ├─ context (contexto por horas, off)
                                                          ├─ persona, audit (hash encadeado), alerts
                                                          ├─ agent + tools (read-only por padrão)
                                                          ├─ dev (aba Código, ex-Jarvis)
                                                          └─ ai/manager ─► legacy-chain | gateway | openai-compatible
                                                                              │
                                              Yui Gateway (:20130) ◄──────────┘ ─► provedores de IA
Scheduler (node-cron) ─► engines GTAO / newswire / youtube / twitch ─► database/*.db (sql.js)
llmHandler: pré-rotas por código (Portas L, M, B, I, A) ─► listas, Modrinth, BDS Server (só GET), imagem, pesquisa
```

## 2. Mapa de módulos e responsabilidades

| Área | Caminho | Responsabilidade | Estado |
|---|---|---|---|
| Entrada | `src/index.js` (208 linhas) | Cria cliente Discord (`:118`), `startApi(client)` (`:169`), `startGatewayServer()` (`:172`); tratadores globais de erro (`:181-203`) que mandam ao log, sem DM, a falha de rede conhecida (`isHarmlessNetworkCrash`) | Funcional |
| Core (fachada) | `src/core/index.js:1-12` | Exporta permissões, memória, audit, persona, ai, `runAgent`, `registerTool` | Funcional |
| Permissões | `src/core/permissions.js:40-93,127-152` | Papéis OWNER/TRUSTED/MEMBER/GUEST/BLOCKED, tipo de canal, escopo de memória, `YUI_READ_ONLY` (padrão ligado), deny por padrão | Funcional (`tests/test-core.js`) |
| Memória | `src/core/memory/{store,schemas}.js` | `remember/recall/forget/purge/admin`; bancos separados | Funcional |
| Backup da memória | `src/core/memory/backup.js` (300 linhas), `scripts/{backup,restore}-memory.mjs` | Cópia cifrada (XChaCha20-Poly1305) e rotativa (`YUI_BACKUP_MAX_KEEP`, padrão 7) dos 4 bancos de memória (`backup.js:124-129`), restauração conferida por hash, alerta ao dono em falha (`:210`); chave só por `YUI_BACKUP_KEY`/`YUI_BACKUP_KEY_FILE` | Funcional por comando (`test:backup`, 6 OK em 10/11/2026); **não agendado** (nenhum cron em `scheduler.js` nem tarefa nos scripts) |
| Contexto por horas | `src/core/context/contextStore.js` | Últimas falas por conversa, TTL por fala | Implementado, **desligado por padrão** |
| Persona | `src/core/persona.js`, `persona/*.md` | Tom por contexto (pessoal / assistente / pública) | Funcional |
| Auditoria | `src/core/audit.js` (258 linhas) | JSONL em `logs/core-audit.jsonl` com hash encadeado (`seq`, `prev_hash`, `hash`), `verifyAudit()` (`:186`), rotação por tamanho (`:153`), alerta ao dono se a gravação falhar (`:142`); a aprovação do módulo Código registra comando, caminho e aprovador (`dev/index.js:161-176`) | Funcional (`test:audit`, 8 OK em 10/11/2026); `verifyAudit()` só é chamado pelos testes |
| Alertas | `src/core/alerts.js` | DM ao dono com intervalo, teto por hora e máscara de segredos; `isHarmlessNetworkCrash` (`:99-111`, não commitado) separa as falhas de rede do pacote `ws` numa conexão já descartada | Funcional (`test:alerts` 24 OK, `test:discordreconnect` 9 OK em 10/11/2026) |
| Agent | `src/core/agent/{agent,tools}.js` | 1 ferramenta por turno, confirmação 2 min, allowlists; ferramentas `bds.*` da biblioteca (só leitura, só OWNER, só com `YUI_BDS_URL`; `tools.js:219-258`, não commitado) | Funcional, **só na API** |
| IA | `src/core/ai/manager.js` | 3 backends; pesquisa na web; regras de privacidade | Funcional |
| Gateway | `src/gateway/*` | Failover/rodízio de chaves entre provedores | Funcional (`tests/test-gateway.js`) |
| API | `src/core/api/{server,auth,admin,integrations,...}.js` | Login, sessões, `/v1/chat`, `/v1/agent`, painel admin, dev | Funcional |
| Código | `src/core/dev/*` | Laço de agente (12 passos), edição por SEARCH/REPLACE, terminal, aprovações | Funcional (modelo real não confirmado) |
| Discord | `src/discord/`, `src/events/`, `src/handlers/` (`llmHandler.js` 4397 linhas) | Comandos, menções, voz, rádio, downloads, GTA, moderação; DM só com o dono (`messageCreate.js:331-341`, `Partials.Channel` em `client.js:21`); proteção de reconexão `src/discord/gatewayGuard.js` (instalada em `client.js:16`, não commitada) | Funcional |
| Pedidos por conversa | `src/handlers/{imageIntent,libraryIntent,chatIntents}.js`, `src/services/bdsLibrary.js` | Porta I (imagem), Porta B (biblioteca do BDS Server: só GET, só o dono, só no privado; desligada sem `YUI_BDS_URL`), Portas N/R (memória e resumo do chat) | I ligada (`llmHandler.js:96,2611`; `test:imageintent`); B ligada (`llmHandler.js:19,2593`; `test:library`), **não commitada**; N/R **não ligadas**: `chatIntents.js` não é importado por nenhum arquivo de `src/` (só `test:chatintents`) |
| Engines | `src/engines/{gtao,newswire,twitch,youtube}` | Coleta e publicação | Funcional (testes com dublês) |
| Scheduler | `src/scheduler/scheduler.js` | Crons (newswire, diário, semanal, youtube, twitch, purge de memória 05:30 UTC em `:62-70`); `minutesToCron` (`:15`) | Funcional |
| TTS/STT | `src/services/tts/*`, `src/services/sttService.js` | Voz da Yui na call | Estruturado e testado offline; call real **(não verificado)** |
| App | `apps/yui-app` | Chat, Memória, Status, Código, Conectar, Admin (Geral/IA/Guild/Ops) | Telas ligadas a `/v1/*` |
| Operação (Windows) | `scripts/instalar-tudo-offline.ps1`, `scripts/atualizar-yui.ps1`, `scripts/yui-supervisor.ps1`, `scripts/instalar-supervisor-windows.ps1` | Tarefas do notebook, atualização diária com volta de versão, watchdog por `/v1/health` | Ver §8 |
| Dados | `database/*.db` (sql.js), `secrets/*.json`, `src/data/*.json` | Persistência | Ver gaps |

## 3. Comunicação entre componentes

- **Discord → Core:** `llmHandler.js` usa `contextFromDiscord`, `buildMemoryBlock`, `captureFromUserText` (`llmHandler.js:2,2525,4107`). A resposta sai da cadeia própria `generateResponse` (`:1921+`), **não** pelo `runAgent` do Core.
- **Discord → pré-rotas por código:** antes do modelo, o `llmHandler` tenta as Portas L (listas), M (mods), B (biblioteca), I (imagem) e A (pesquisa) (`llmHandler.js:2567-2640`). A Porta B chama o BDS Server só com GET (`bdsLibrary.js:57`), com endereço vindo do `.env` (`YUI_BDS_URL`).
- **App → Core:** `POST /v1/chat` e `/v1/agent` (`server.js:449-490`) → `buildMemoryBlock`, `ai.chatTurn`, `runAgent`.
- **Core → IA:** `AI_BACKEND` (padrão `legacy-chain`) → `import()` dinâmico de `llmHandler.js` (`manager.js:142,400`).
- **Gateway:** entra como `tryGateway` logo após o LM Studio na cadeia legada (`llmHandler.js:1930`) e como backend do Core (`manager.js:475`).
- **Acesso remoto:** API em `127.0.0.1`; `tailscale serve --bg --https=3939 http://127.0.0.1:3939`; `funnel` proibido (`docs/content_pt/OPERACAO.md` §2, Portas e serviços).

## 4. Dependências

- **Externas (runtime):** discord.js, @discordjs/voice, sql.js, axios, cheerio, puppeteer, node-cron, winston, msedge-tts, @gradio/client, @noble/ciphers.
- **Ferramentas externas:** yt-dlp, spotdl (`.venv-spotdl`), deemix (`.venv-deemix`), LM Studio (IA local), Tailscale; BDS Server (servidor de arquivos, opcional, só leitura via `YUI_BDS_URL`).
- **Serviços de IA em nuvem:** Groq, Gemini, Hugging Face, OpenRouter, Cloudflare, Together, Pollinations (anônimo), Horde (anônimo).
- **Internas:** `core/ai/manager` depende de `handlers/{researchAgent,searchIntent,llmSafety}` (`manager.js:5-12`) — o Core importa módulos de `handlers/`.
- **Defeito conhecido (10/11/2026):** o discord.js instalado (14.27.0; `package.json` pede `^14.17.3`) usa a `@discordjs/ws` 1.2.3, cujo `WebSocketShard.destroy()` solta o `onerror` da conexão (`node_modules/@discordjs/ws/dist/index.js:755`) mas só fecha a conexão se ela estiver aberta. Contorno em `src/discord/gatewayGuard.js`; detalhes e ação futura em `GAPS_E_DEBITOS_TECNICOS.md` §7.

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
| Discord | Completa, mas com pipeline próprio (`llmHandler`) e permissões paralelas ao Agent do Core. Desde `dd96b15` o privado (DM) só atende o dono; DM de outra pessoa é ignorada em silêncio (`test:dmowner`, 4 OK em 10/11/2026) |
| App web/Android | Telas reais; Android **nunca foi buildado** (sem pasta `android/`, só `app.json`); sem APK, notificações, streaming. No notebook, o app web sobe pela tarefa `YuiWebApp` em `:8081` (§8) |
| Desktop | **Não existe neste repositório.** A documentação cita "Yui Desktop" (Electron) em `D:\Projetos\Projeto Jarvis\Yui Desktop` (fora do repo, não auditada). Faltam aprovações nativas do Windows |
| Voz | Módulo TTS maduro; STT existe; teste em call real pendente |
| Contexto compartilhado entre interfaces | Não. Contexto por horas é por canal (`dm:<id>`/`ch:<canal>:u:<id>`); a API usa `Map` em RAM. Só a memória de longo prazo é por `userId`/escopo |

## 7. Duplicações, acoplamentos e gargalos

1. **Duas cadeias de provedores de IA** (`llmHandler.js:1351-1945` e `gateway/providers.js`); o próprio `manager.js:28-30` admite a extração como "evolução futura".
2. **Dois sistemas de política** não relacionados: `permissions.js` (`access`+`confirm`) e `dev/policy.js` (`allow/ask/deny`). O motor único só existe como especificação (`docs/ESPECIFICACAO_MOTOR_POLITICAS_FASE1.md`); não há `src/core/policy`.
3. **Três mecanismos de histórico:** `contextStore`, `Map` em RAM da API (`server.js:203-204`), histórico por canal do `llmHandler`; mais `historico.txt` sem retenção.
4. **Agent do Core só na API;** o Discord tem ferramentas e MCP internos próprios.
5. **`llmHandler.js` monolítico** (4397 linhas em 10/11/2026; eram 4302 em 05/11).
6. **Persistência sql.js em RAM:** cada escrita regrava o arquivo inteiro de forma síncrona (`db.js:151-155`); `remember` fora de transação ≈ 3 regravações; `touchUser` regrava por mensagem (`store.js:50-59`).
7. **Dois processos sobre a mesma pasta de bancos perdem escritas** (sem lock de arquivo).
8. **Config duplicada:** `src/config.js` e `src/config/{index.js,config.json,constants.js}`.
9. **Um `activeRun` global** no módulo dev (`dev/index.js:57,130`).
10. **Dois supervisores possíveis (10/11/2026):** o laço da tarefa `YuiBot` e `scripts/yui-supervisor.ps1`, que inicia o seu próprio `node src/index.js`. Instalar os dois no mesmo computador poria duas Yuis no ar com o mesmo token do Discord.

## 8. Infraestrutura atual

- **Execução (desde 03/11/2026):** notebook dedicado (Windows 10, 4 GB de RAM). Tarefas do Agendador do Windows como SYSTEM, disparadas no boot:
  - `YuiBot`: laço `while ($true) { node src/index.js; Start-Sleep -Seconds 15 }`, começa 45 s depois do boot (`scripts/instalar-tudo-offline.ps1:147-158,163-164`);
  - `YuiWebApp`: o mesmo laço com `apps/yui-app/scripts/serve-web.mjs`, app web em `:8081` (`instalar-tudo-offline.ps1:168-169`);
  - `YuiAtualizar`: diária, roda `scripts/atualizar-yui.ps1`. Nenhum script do repositório cria essa tarefa (instalada à parte).
  No PC de desenvolvimento seguem `Yui.bat` (menu) e `setup.ps1`; `scripts/yui.service` (Linux) e `discloud.config` são de hospedagens antigas.
- **Atualização (`scripts/atualizar-yui.ps1`):** compara o último commit do `main` no GitHub com `C:\Yui\.versao-instalada`; se mudou, baixa o zip, guarda `src/` e `package*.json` em `C:\Yui-backup` (3 últimas), copia por cima sem tocar em `.env`, `database`, `logs`, `secrets`, `node_modules`, ambientes Python, `*.db` e dados que a Yui altera; roda `npm install` se o `package-lock` mudou; reinicia `YuiBot` e, se o processo não ficar de pé por 45 s, volta `src/` e `package*.json` e não marca a versão como instalada. Log em `C:\Tools\atualizar-yui.log`.
- **Health e religamento:** `/v1/health` público (expõe `backends` e flags). O laço do `YuiBot` religa o processo 15 s depois que ele sai, e a DM "Estou no ar" (`index.js:138`, intervalo de 5 min) avisa o dono a cada subida. Processo **travado sem sair não é detectado**. O watchdog por `/v1/health` (`scripts/yui-supervisor.ps1` + `scripts/instalar-supervisor-windows.ps1`, com `-DryRun`) existe mas **não está instalado no notebook**; do jeito que está, ele inicia o seu próprio `node src/index.js`, a tarefa dele dispara no logon do usuário e o health só existe com `YUI_API_ENABLED=true`, ou seja, substituiria o `YuiBot` em vez de complementá-lo.
- **Rede:** em 10/11/2026 o Wi-Fi do notebook ficou fora de ~23h41 a ~00h20; a reconexão do Discord gerou a exceção "Opening handshake has timed out", hoje contida pelo `gatewayGuard.js` (§4).
- **Tailscale:** só documentação; o supervisor (não instalado) verificaria o `tailscale serve`. Uso do Tailscale no notebook **(não verificado)**.
- **Logs:** `logs/app-AAAA-MM-DD.log` (14 dias) e `logs/error-AAAA-MM-DD.log` (30 dias), até 10 MB cada, com rotação do winston (`src/utils/logger.js:34-48`; a versão de 05/11 dizia "sem política de retenção visível", o que já não era exato); auditoria em `logs/core-audit.jsonl` com rotação própria (`audit.js:153`).
- **Scripts de operação versionados desde `c368991`:** `scripts/instalar-ssh.ps1`, `instalar-tudo-offline.ps1`, `otimizar-windows.ps1`, `scripts/modpack/` (em 05/11 estavam fora do git).

## 9. Testes executados nesta auditoria

| Comando | Resultado |
|---|---|
| `node tests/test-core.js` | 21 testes OK (banco e auditoria em diretório temporário) |
| `npm test` em `apps/yui-app` | 23 aprovados, 0 falhas |
| Demais (`test-core-api`, `test-gateway`, `test-readonly`, `typecheck`, testes TTS/engines) | **Não executados** (incerteza sobre dependência de rede); os "2.900 verificações" da documentação são afirmação dela, não reconfirmada |
| Reexecutados em 10/11/2026 (offline) | `test:core` 21 OK; `test:alerts` 24 OK; `test:backup` 6/6; `test:audit` 8/8; `test:discordreconnect` 9 OK; `test:library` 10/10; `test:imageintent` 9/9; `test:chatintents` 11/11; `test:dmowner` 4/4; `test:cleanbootstrap` 1/1 |
