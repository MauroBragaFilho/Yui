# GAPS_E_DEBITOS_TECNICOS — Yui

Auditoria somente leitura de 2026-11-05. IDs `R..` correspondem às recomendações detalhadas em `AUDITORIA_TECNICA.md` (§6). Prioridade: P0 (antes de ampliar autonomia), P1, P2, P3.

## 1. Matriz funcional (estado real)

| Funcionalidade | Estado | Evidência / observação |
|---|---|---|
| Papéis e permissões | Implementada e funcional | `permissions.js`, `test-core.js` (21 OK, rodado) |
| Memória do dono (permanente) | Implementada e funcional | `store.js:73` (`expires_at` NULL), banco `memory-personal` |
| Memória de usuários (30 dias deslizantes) | Implementada e funcional | `store.js:20-59`; purge diário `scheduler.js:61-70` |
| Captura automática de memória | Parcial | 3 regex (`discordAdapter.js:49-53`); sem sumarização |
| Memória ligada por padrão | **Divergente** | Código assume `false` sem variável (`discordAdapter.js:16`); doc mostra `true`. Conferir `.env` real (não lido) |
| Contexto por horas | Implementada, **desligada**; teste real pendente | `contextStore.js`; pendência 12 da doc |
| Limpeza ao banir/sair de servidor | **Presente, não integrada** | `forgetGuildContext`/`forgetUserContext` sem chamadores |
| Busca de memória | Parcial (léxica, 200 linhas, sem FTS/embeddings) | `store.js:97-123` |
| Pessoas/projetos/relações | **Planejada** | Só `type='project'`; sem entidades |
| Memória episódica/semântica | **Planejada** | Sem código |
| Backup/restauração da memória | **Ausente** | Pendência 4 da doc |
| Agent com ferramentas do PC | Implementada, só leitura, só na API | `agent.js`, `tools.js` |
| Agent no Discord | **Presente, não integrado** | `runAgent` só chamado pela API |
| Ferramentas `write` | Planejada | Pendência 10 |
| Transporte MCP | Parcial (só ponte de permissões) | `tools.js:318-339` |
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
| Tailscale | Apenas documentado | `OPERACAO.md:51-71` |
| Auto-start / watchdog no Windows | **Ausente** | Só `yui.service` (Linux) |
| Papéis TRUSTED/GUEST | Presentes, sem função | Pendência 6 |
| Recados de membros ao dono | Planejada | Pendência 14 |
| Visão multimodal | Possivelmente não implementada | `FEATURES.md:29` ambíguo (não verificado) |
| Modo `dev:api --fake` | Simulada de propósito | `YUI_API.md:57` |

## 2. Gaps de segurança

| ID | Problema | Evidência | Sev. | Rec. |
|---|---|---|---|---|
| S1 | "Pedido local" definido por ausência de cabeçalhos de proxy; proxy local mal configurado liberaria aprovação/gravação remota | `dev/routes.js:22-33`, `dev/index.js:231` | Alta | R02 |
| S2 | Terminal com `shell:true` e lista negra por regex (bypass: `powershell -enc`, `python -c`, `node -e`, `cmd /c`, `curl -o`...) | `policy.js:20-35`, `terminal.js:54` | Alta | R03 |
| S3 | Auditoria mutável; não registra comando aprovado, caminho gravado nem aprovador; `answerApproval` descarta `ctx` | `audit.js:27-29`, `dev/index.js:165,236` | Alta | R04 |
| S4 | Token do app em texto puro (AsyncStorage/localStorage); tokens fixos de `YUI_API_TOKENS` não expiram | `storage.ts:8-10,47` | Alta | R09 |
| S5 | Senha em texto no `.env` aceita (só aviso); API em HTTP aceita se `YUI_API_HOST` não for loopback (só aviso) | `auth.js:67,76`, `server.js:571` | Média | R09 |
| S6 | Bloqueio de login global: qualquer um que alcance a porta trava o dono por 15 min | `auth.js:150-172` | Média | R12 |
| S7 | Rate limit só após autenticação; `/v1/health` público expõe backends e flags | `server.js:332,418` | Média | R12 |
| S8 | `secrets/ai-providers.json` sem cifragem comprovada; `Yui.pem` na raiz do repo (ignorado no git) | `.gitignore`; cifragem não verificada | Média | R09 |
| S9 | `activeRun` global; runs sem dono | `dev/index.js:130,217-221` | Média | R19 |
| S10 | Filtro de arquivos sensíveis só por nome | `workspace-fs.js:20` | Baixa | R03 |
| S11 | `audit()` engole erros; sem rotação | `audit.js:29` | Baixa | R04 |
| S12 | Ferramentas MCP externas viram WRITE+confirm genéricas sem auditar o servidor | `tools.js:322-339` | Média | R14 |

**Controles bons confirmados:** `timingSafeEqual`, scrypt, path traversal (`path.relative`+`realpath`), ambiente sem segredos para processos filhos, read-only por padrão, deny por padrão, `.env`/`secrets/`/`*.pem` fora do git (`git check-ignore`, sem histórico).

## 3. Gaps de dados e memória

| ID | Problema | Evidência | Rec. |
|---|---|---|---|
| D1 | Sem backup nem restauração de `memory-personal.db` — principal risco de perda | doc pendência 4 | R05 |
| D2 | Gravação síncrona integral por escrita; ≈3 regravações por `remember` | `db.js:151-155`, `store.js:50-59` | R06 |
| D3 | Sem lock entre processos; segundo processo perde escritas | `db.js` | R06 |
| D4 | Fallback de gravação direta perde atomicidade | `db.js:165-175` | R06 |
| D5 | Busca limitada a 200 linhas; `LIKE` não normaliza acentos no SQL | `store.js:111-113` | R11 |
| D6 | `historico.txt` sem retenção; sem comando de exclusão | pendência 13 | R11 |
| D7 | Bancos de runtime versionados no git e já modificados: `database/{core,gta-diario,gta-semanal,newswire,social-*}.db` | `git ls-files`, `git status` | R07 |
| D8 | Cookies de sessão do Reddit versionados (`reddit-cookies-cache.json`); `bans.json`, `user_pc_specs.json`, `watchedUsers.json`, auditorias de log (`logs/.*-audit.json`, `apps/yui-app/logs/*`) versionados | `git ls-files` | R07 |
| D9 | Sem entidades pessoa/projeto/relação | `schemas.js` | R11 |

## 4. Gaps de infraestrutura

| ID | Problema | Rec. |
|---|---|---|
| I1 | Sem auto-start no Windows nem watchdog; `/v1/health` existe mas nada reage a ele | R08 |
| I2 | `tailscale serve` só documentado; pode se perder no reboot; nada verifica | R08 |
| I3 | Processo único: falha em qualquer parte derruba bot, API e Gateway | R08/R10 |
| I4 | Sem rotação/retenção de `logs/app-*.log` | R08 |
| I5 | Android nunca buildado; sem APK; Desktop fora do repo | R13/R18 |

## 5. Débitos técnicos e higiene

| ID | Item | Rec. |
|---|---|---|
| T1 | Duas cadeias de provedores de IA (`llmHandler.js` × `gateway/providers.js`) | R10 |
| T2 | Duas políticas (`permissions.js` × `dev/policy.js`) | R01 |
| T3 | `llmHandler.js` com 4302 linhas | R10 |
| T4 | Core importa `handlers/*` (`manager.js:5-12`); `legacy-chain` arrasta o Discord | R10 |
| T5 | Três mecanismos de histórico | R10/R11 |
| T6 | `.env_example` (desatualizado) ao lado de `.env.example`; `Yui.bat` e `yui.bat` (colisão no Windows); `.gitignore` ignora `*.bat`/`*.txt` mas há `.bat` versionados; `*.env.*` ignora `.env.example` | R16 |
| T7 | `scripts/convert-to-esm.js` residual; `src/config.js` × `src/config/*` duplicados | R16 |
| T8 | Documentos na raiz (`INTEGRACAO_MOTORES_GTA.md`, `PROVEDORES_IA_GRATUITOS.md`, `RESUMO_INTEGRACAO.md`, `README_TESTES.md`, `test-gtao-output.txt`) sobrepostos a `docs/content_pt` | R16 |
| T9 | `.venv-deemix`/`.venv-spotdl` na raiz (ignorados? não confirmado) | R16 |
| T10 | Sem lint nem build no `package.json`; ~60 scripts `test:*` sem runner único; sem CI | R20 |
| T11 | Testes ausentes para `adminList*`, `captureFromUserText`; vários testes dependem de rede e não foram reexecutados | R20 |
| T12 | Working tree sujo: 12 modificados + 4 não rastreados | R07/R16 |
| T13 | Persona legada `persona/arquivo-prompt-antigo.md` (9,8 KB) | R16 |

## 6. Itens que a auditoria não conseguiu verificar

`.env` real; conteúdo de `secrets/*` e `Yui.pem`; cifragem de `ai-providers.json`; `docs/content_pt/{CODIGO,MODERATION}.md`; `ConnectScreen.tsx` e `CodeScreen.tsx` em profundidade; se cada rota de `client.ts` existe no servidor; `spotifyDownloadHandler`/`llmSafety` em profundidade; voz em call real; o projeto Electron externo; tamanho real dos `.db`; comportamento em runtime de qualquer componente.
