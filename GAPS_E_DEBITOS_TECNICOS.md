# GAPS_E_DEBITOS_TECNICOS — Yui

Auditoria somente leitura de 2026-11-05. IDs `R..` correspondem às recomendações detalhadas em `AUDITORIA_TECNICA.md` (§6). Prioridade: P0 (antes de ampliar autonomia), P1, P2, P3.

> **Atualizado em 10/11/2026** contra a árvore de trabalho (inclui mudanças ainda não commitadas). Cada status alterado traz a evidência (arquivo, script de teste) e a data. Testes citados como "rodado em 10/11/2026" foram executados offline nesta revisão. Item novo: §7 (Dependências).

## 1. Matriz funcional (estado real)

| Funcionalidade | Estado | Evidência / observação |
|---|---|---|
| Papéis e permissões | Implementada e funcional | `permissions.js`, `test-core.js` (21 OK, rodado; de novo em 10/11/2026) |
| Memória do dono (permanente) | Implementada e funcional | `store.js:73` (`expires_at` NULL), banco `memory-personal` |
| Memória de usuários (30 dias deslizantes) | Implementada e funcional | `store.js:20-59`; purge diário `scheduler.js:62-70` |
| Captura automática de memória | Parcial | 3 regex (`discordAdapter.js:49-53`); sem sumarização |
| Memória ligada por padrão | **Divergente** | Código assume `false` sem variável (`discordAdapter.js:16`); doc mostra `true`. Conferir `.env` real (não lido) |
| Contexto por horas | Implementada, **desligada**; teste real pendente | `contextStore.js`; pendência 12 da doc |
| Limpeza ao banir/sair de servidor | **Presente, não integrada** | `forgetGuildContext` sem chamadores; `forgetUserContext` só é chamado pelo `/memoria`, a pedido do próprio usuário (`discord/commands/memoria.js:31`), nunca ao banir/sair |
| Busca de memória | Parcial (léxica, 200 linhas, sem FTS/embeddings) | `store.js:97-123` |
| Pessoas/projetos/relações | **Planejada** | Só `type='project'`; sem entidades |
| Memória episódica/semântica | **Planejada** | Sem código |
| Backup/restauração da memória | **Implementada (10/11/2026); não agendada** | Era "Ausente". `src/core/memory/backup.js` (XChaCha20-Poly1305, rotação, hash, alerta), `scripts/backup-memory.mjs`, `scripts/restore-memory.mjs`; `test:backup` 6/6 (rodado em 10/11/2026). Nenhum cron (`scheduler.js`) nem tarefa do Windows roda o backup |
| Agent com ferramentas do PC | Implementada, só leitura, só na API | `agent.js`, `tools.js`; ferramentas `bds.*` da biblioteca, só leitura e só OWNER (`tools.js:219-258`, não commitado) |
| Agent no Discord | **Presente, não integrado** | `runAgent` só chamado pela API (`server.js:486`) |
| Ferramentas `write` | Planejada | Pendência 10 |
| Transporte MCP | Parcial (só ponte de permissões) | `tools.js:364-385` |
| Aba Código (ex-Jarvis) | Implementada; modelo real não confirmado | `core/dev/*`; testes com IA simulada |
| AI Manager / Gateway | Implementada e funcional | `manager.js`, `gateway/*` |
| Agente de pesquisa | Implementada; uso real pendente | Pendência 17; testado com dublês |
| App web | Implementada (telas ligadas a `/v1/*`) | `client.ts`; 23 testes OK (rodado) |
| App Android | **Não construída** | Sem `android/`; sem APK |
| Yui Desktop (Electron) | **Fora deste repositório** | Citado em docs; não auditado |
| Streaming SSE | Planejada | Pendência 1 |
| Notificações push | Planejada | Pendência 3 |
| Voz (TTS) | Implementada, testada offline; call real não confirmada | `src/services/tts/*` |
| STT | Presente; estado real não verificado | `sttService.js` |
| Tailscale | Apenas documentado | `docs/content_pt/OPERACAO.md` §2 (Portas e serviços); o supervisor que o verificaria não está instalado |
| Auto-start / watchdog no Windows | **Parcial (10/11/2026)** | Era "Ausente". Auto-start e religamento no notebook: tarefas SYSTEM `YuiBot`/`YuiWebApp` no boot, laço que religa o `node` 15 s depois de sair (`scripts/instalar-tudo-offline.ps1:147-169`). Watchdog por `/v1/health` (`scripts/yui-supervisor.ps1`) existe mas **não está instalado**. Ver I1 |
| Atualização automática | Implementada (10/11/2026) | `scripts/atualizar-yui.ps1` (diária pela tarefa `YuiAtualizar`, com volta de versão); ver I6 |
| DM só com o dono | Implementada e funcional (10/11/2026) | `dd96b15`; `Partials.Channel` (`client.js:21`), `isForeignDirectMessage` (`messageCreate.js:331-341`); `test:dmowner` 4/4 (rodado em 10/11/2026) |
| Imagem por conversa (Porta I) | Implementada (10/11/2026) | `271a6a9`; `src/handlers/imageIntent.js`, `llmHandler.js:96,2611`; `test:imageintent` 9/9 (rodado em 10/11/2026) |
| Memória e resumo por conversa (Portas N e R) | **Integrada** (10/11/2026) | `d29d29b` + ligação no `llmHandler.js`; `test:chatintents` 12/12. Ver T14 (resolvido) |
| Biblioteca por conversa (Porta B) | Implementada, **não commitada** (10/11/2026) | `src/handlers/libraryIntent.js`, `src/services/bdsLibrary.js` (só GET, `:57`), `llmHandler.js:19,2593`; só o dono, só no privado; desligada sem `YUI_BDS_URL`; `test:library` 10/10 (rodado em 10/11/2026) |
| Papéis TRUSTED/GUEST | Presentes, sem função | Pendência 6 |
| Recados de membros ao dono | Planejada | Pendência 14 |
| Visão multimodal | Possivelmente não implementada | `FEATURES.md:29` ambíguo (não verificado) |
| Modo `dev:api --fake` | Simulada de propósito | `YUI_API.md:57` |

## 2. Gaps de segurança

| ID | Problema | Evidência | Sev. | Rec. |
|---|---|---|---|---|
| S1 | "Pedido local" definido por ausência de cabeçalhos de proxy; proxy local mal configurado liberaria aprovação/gravação remota | `dev/routes.js:22-33`, `dev/index.js:248` | Alta | R02 |
| S2 | Terminal com `shell:true` e lista negra por regex (bypass: `powershell -enc`, `python -c`, `node -e`, `cmd /c`, `curl -o`...) | `policy.js:20-35`, `terminal.js:54-57` | Alta | R03 |
| S3 | **Parcialmente resolvido (10/11/2026).** Era: auditoria mutável, sem comando aprovado, caminho gravado nem aprovador, `answerApproval` descartando `ctx`. Hoje: hash encadeado e `verifyAudit()`, aprovação registra comando, caminho, pasta e aprovador, `answerApproval` repassa o `ctx`. Falta: verificação periódica (`verifyAudit()` só é chamado pelos testes), cópia fora do projeto e âncora externa (o hash é SHA-256 sem chave: quem reescreve o arquivo pode recalcular a cadeia) | `audit.js:20-33,103-147,186`; `dev/index.js:161-176,252`; `test:audit` 8/8 (rodado em 10/11/2026) | Média (era Alta) | R04 |
| S4 | Token do app em texto puro (AsyncStorage/localStorage); tokens fixos de `YUI_API_TOKENS` não expiram | `storage.ts:8-10,47` | Alta | R09 |
| S5 | Senha em texto no `.env` aceita (só aviso); API em HTTP aceita se `YUI_API_HOST` não for loopback (só aviso) | `auth.js:67,76`, `server.js:571` | Média | R09 |
| S6 | Bloqueio de login global: qualquer um que alcance a porta trava o dono por 15 min | `auth.js:150-172` | Média | R12 |
| S7 | Rate limit só após autenticação; `/v1/health` público expõe backends e flags | `server.js:332,418` | Média | R12 |
| S8 | `secrets/ai-providers.json` sem cifragem comprovada; `Yui.pem` na raiz do repo (ignorado no git) | `.gitignore`; cifragem não verificada | Média | R09 |
| S9 | `activeRun` global; runs sem dono | `dev/index.js:57,130,234-238` | Média | R19 |
| S10 | Filtro de arquivos sensíveis só por nome | `workspace-fs.js:20` | Baixa | R03 |
| S11 | **Resolvido em grande parte (10/11/2026).** Era: `audit()` engolia erros, sem rotação. Hoje: falha de gravação vira alerta ao dono e há rotação por tamanho (`YUI_AUDIT_MAX_BYTES`, `YUI_AUDIT_MAX_ROTATE`). Resta: por padrão a falha não interrompe a ação auditada (`throwOnError=false`) | `audit.js:103,142,153-173` | Baixa | R04 |
| S12 | Ferramentas MCP externas viram WRITE+confirm genéricas sem auditar o servidor | `tools.js:368-385` | Média | R14 |

**Controles bons confirmados:** `timingSafeEqual`, scrypt, path traversal (`path.relative`+`realpath`), ambiente sem segredos para processos filhos, read-only por padrão, deny por padrão, `.env`/`secrets/`/`*.pem` fora do git (`git check-ignore`, sem histórico).

## 3. Gaps de dados e memória

| ID | Problema | Evidência | Rec. |
|---|---|---|---|
| D1 | **Parcialmente resolvido (10/11/2026).** Era: sem backup nem restauração de `memory-personal.db`. Hoje o backup cifrado e a restauração existem e têm teste. Falta: rotina agendada (nada roda o backup sozinho) e destino/chave fora do notebook (decisão 3 do roadmap) | `core/memory/backup.js`, `scripts/{backup,restore}-memory.mjs`, `test:backup` 6/6; `scheduler.js` sem tarefa de backup | R05 |
| D2 | Gravação síncrona integral por escrita; ≈3 regravações por `remember` | `db.js:151-155`, `store.js:50-59` | R06 |
| D3 | Sem lock entre processos; segundo processo perde escritas | `db.js` | R06 |
| D4 | Fallback de gravação direta perde atomicidade | `db.js:165-175` | R06 |
| D5 | Busca limitada a 200 linhas; `LIKE` não normaliza acentos no SQL | `store.js:111-113` | R11 |
| D6 | `historico.txt` sem retenção; sem comando de exclusão | pendência 13 | R11 |
| D7 | Bancos de runtime versionados no git e já modificados: `database/{core,gta-diario,gta-semanal,newswire,social-*}.db` (e `database/gta-semanal.db.bak`). Seguem rastreados e modificados em 10/11/2026; roteiro em `docs/ROTEIRO_DADOS_RUNTIME_GIT_R07.md`, aguardando decisão do dono. No notebook, `atualizar-yui.ps1` não sobrescreve `*.db` | `git ls-files`, `git status` | R07 |
| D8 | Cookies de sessão do Reddit versionados (`reddit-cookies-cache.json`); `bans.json`, `user_pc_specs.json`, `watchedUsers.json`, auditorias de log (`logs/.*-audit.json`, `apps/yui-app/logs/*`) versionados. Sem mudança em 10/11/2026 (proposta em `docs/PROPOSTA_GITIGNORE_R07.md`) | `git ls-files` | R07 |
| D9 | Sem entidades pessoa/projeto/relação | `schemas.js` | R11 |

## 4. Gaps de infraestrutura

| ID | Problema | Rec. |
|---|---|---|
| I1 | **Parcial (10/11/2026).** Era: sem auto-start no Windows nem watchdog. Hoje, no notebook (produção desde 03/11/2026): tarefas SYSTEM no boot (`YuiBot`, `YuiWebApp`) com laço que religa o processo 15 s depois que ele sai, e DM "Estou no ar" a cada subida (`index.js:138`). Falta: watchdog por saúde (processo travado sem sair não é detectado); `scripts/yui-supervisor.ps1` + `instalar-supervisor-windows.ps1` existem mas **não estão instalados** e, como estão, iniciam o próprio `node src/index.js` (conflita com `YuiBot`: duas Yuis com o mesmo token), disparam no logon do usuário (não no boot como SYSTEM) e só têm health com `YUI_API_ENABLED=true` | R08 |
| I2 | `tailscale serve` só documentado; pode se perder no reboot; nada verifica (o supervisor faria, mas não está instalado; uso do Tailscale no notebook não verificado) | R08 |
| I3 | Processo único: falha em qualquer parte derruba bot, API e Gateway | R08/R10 |
| I4 | **Corrigido na revisão de 10/11/2026 (o achado estava impreciso):** o winston já rotaciona `logs/app-*.log` (14 dias) e `logs/error-*.log` (30 dias), até 10 MB cada (`src/utils/logger.js:34-48`). Resta sem rotação: `historico.txt` (D6) e o log do atualizador `C:\Tools\atualizar-yui.log` (`Add-Content` sem limite) | R08 |
| I5 | Android nunca buildado; sem APK; Desktop fora do repo | R13/R18 |
| I6 | Atualizador diário (`scripts/atualizar-yui.ps1`, novo): instala o `main` do GitHub sem rodar testes; confere só se `node src/index.js` está vivo há 45 s (não consulta `/v1/health` nem o Discord); a volta de versão restaura só `src/` e `package*.json`; a cópia (`robocopy` sem `/PURGE`) não apaga arquivos removidos do repositório; nenhum script do repo cria a tarefa `YuiAtualizar` | R08/R20 |

## 5. Débitos técnicos e higiene

| ID | Item | Rec. |
|---|---|---|
| T1 | Duas cadeias de provedores de IA (`llmHandler.js` × `gateway/providers.js`) | R10 |
| T2 | Duas políticas (`permissions.js` × `dev/policy.js`); o motor único só existe como especificação (`docs/ESPECIFICACAO_MOTOR_POLITICAS_FASE1.md`) | R01 |
| T3 | `llmHandler.js` com 4397 linhas (10/11/2026; eram 4302) | R10 |
| T4 | Core importa `handlers/*` (`manager.js:5-12`); `legacy-chain` arrasta o Discord | R10 |
| T5 | Três mecanismos de histórico | R10/R11 |
| T6 | `.env_example` (desatualizado) ao lado de `.env.example`; `Yui.bat` e `yui.bat` (colisão no Windows); `.gitignore` ignora `*.bat`/`*.txt` mas há `.bat` versionados; `*.env.*` ignora `.env.example` | R16 |
| T7 | `scripts/convert-to-esm.js` residual; `src/config.js` × `src/config/*` duplicados | R16 |
| T8 | Documentos na raiz (`INTEGRACAO_MOTORES_GTA.md`, `PROVEDORES_IA_GRATUITOS.md`, `RESUMO_INTEGRACAO.md`, `README_TESTES.md`, `test-gtao-output.txt`) sobrepostos a `docs/content_pt` | R16 |
| T9 | `.venv-deemix`/`.venv-spotdl` na raiz; ignorados pelo git (`.gitignore:50-51`, conferido com `git check-ignore` em 10/11/2026) | R16 |
| T10 | Sem lint nem build no `package.json`; 74 scripts `test:*` (10/11/2026) sem runner único (não há `npm test` na raiz; `scripts/run-tests.sh` só roda os motores do GTA); sem CI (não há `.github/`) | R20 |
| T11 | Vários testes dependem de rede e não foram reexecutados. **Corrigido em 10/11/2026 (o achado estava impreciso):** `adminListUsers`/`adminListMetadata` e `captureFromUserText` já são cobertos por `tests/test-core.js:92-112,147-167` | R20 |
| T12 | Working tree sujo: 12 modificados + 4 não rastreados em 05/11; 27 modificados + 7 não rastreados no início da revisão de 10/11/2026 (bancos, cookies, auditorias e o trabalho ainda não commitado da Porta B e da reconexão do Discord) | R07/R16 |
| T13 | Persona legada `persona/arquivo-prompt-antigo.md` (9,8 KB) | R16 |
| T14 | `src/handlers/chatIntents.js` (Portas N e R, `d29d29b`) commitado sem chamador; **resolvido em 10/11/2026**: ligado no `llmHandler.js` | — |
| T15 | O nome "Porta B" é usado para duas coisas no `llmHandler.js`: agente de pesquisa (`:3329`) e biblioteca (`:2593`) | R16 |

## 6. Itens que a auditoria não conseguiu verificar

`.env` real; conteúdo de `secrets/*` e `Yui.pem`; cifragem de `ai-providers.json`; `docs/content_pt/{CODIGO,MODERATION}.md`; `ConnectScreen.tsx` e `CodeScreen.tsx` em profundidade; se cada rota de `client.ts` existe no servidor; `spotifyDownloadHandler`/`llmSafety` em profundidade; voz em call real; o projeto Electron externo; tamanho real dos `.db`; comportamento em runtime de qualquer componente.

Na revisão de 10/11/2026 (sem acesso ao notebook): o estado real das tarefas `YuiBot`, `YuiWebApp` e `YuiAtualizar` e o horário desta última (informados pelo dono, não conferidos); se a API (`YUI_API_ENABLED`) e o Tailscale estão ligados no notebook; o `.env` do notebook (por exemplo `YUI_BDS_URL`).

## 7. Dependências

| ID | Problema | Evidência | Contorno atual | Ação futura |
|---|---|---|---|---|
| DEP1 | A `@discordjs/ws` 1.2.3 (última da linha 1.x, usada pelo discord.js 14; instalado 14.27.0) tem um defeito: `WebSocketShard.destroy()` solta o tratador de erro da conexão (`onerror = null`), mas só a fecha se ela estiver ABERTA. Se a rede cai no meio do handshake, a conexão em andamento fica órfã e, quando o prazo de 30 s vence, vira exceção não capturada "Opening handshake has timed out". Visto em produção em 10/11/2026 (Wi-Fi do notebook fora de ~23h41 a ~00h20); a Yui reconectou sozinha, mas o dono recebeu DM de "Erro grave" | `node_modules/@discordjs/ws/dist/index.js:755` (`onerror = null` depois do `if (shouldClose)`), `handshakeTimeout: 3e4` (`:554`) | `src/discord/gatewayGuard.js` envolve o `destroy` e dá à conexão não aberta um ouvinte de `'error'` que só registra no log (instalado em `src/discord/client.js:16`); `isHarmlessNetworkCrash` em `src/core/alerts.js:99-111` (usado em `src/index.js:181-203`) impede que essa falha vire DM de "Erro grave". `npm run test:discordreconnect` reproduz o defeito com a biblioteca real e confere o contorno (9 OK, rodado em 10/11/2026). Tudo ainda não commitado | Remover o contorno quando atualizar para uma `@discordjs/ws` que feche/termine a conexão em andamento no `destroy` (conferir ao migrar para discord.js 15 / `@discordjs/ws` 2.x). O próprio `installGatewayGuard` avisa no log se o ponto de encaixe sumir |
