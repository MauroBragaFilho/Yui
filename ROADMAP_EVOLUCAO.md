# ROADMAP_EVOLUCAO — Yui

Plano (na data da auditoria, 2026-11-05, nada estava implementado). IDs R01–R20 em `AUDITORIA_TECNICA.md` §6 (problema, evidência, solução, dependências, risco, prioridade e critério de conclusão de cada um). **Nenhuma fase começa sem aprovação do dono.**

> **Atualizado em 10/11/2026:** parte da Fase 0 já existe no código (R05 e R04 implementadas; R08 parcial; R07 só com roteiro). Situação por recomendação, com evidência, em [Estado em 10/11/2026](#estado-em-10112026). Desde 03/11/2026 a produção roda num notebook dedicado, não mais no PC.

## Visão por fases

| Fase | Objetivo | Recomendações | Prioridade | Pré-requisito |
|---|---|---|---|---|
| **0 — Fundação segura** | Proteger o que existe; zero funcionalidade nova | R05 backup, R04 auditoria encadeada, R07 dados fora do git, R08 auto-start/watchdog/Tailscale, R16 higiene (parcial) | P0 | Aprovação desta auditoria |
| **1 — Política de 4 estados** | Uma decisão para todas as interfaces | R01 motor, R03 terminal sem shell, R02 canal de aprovação (versão loopback), R12 borda da API, R20 testes/runner | P0/P1 | Fase 0 (auditoria e backup) |
| **2 — Interfaces e credenciais** | Aprovação nativa e acesso móvel seguro | R13 Desktop, R09 credenciais, R18 Android/APK, R19 runs por sessão | P1/P2 | Fase 1 |
| **3 — Core unificado** | Um pipeline, Core sem Discord | R10 (por etapas, atrás de flag), R06 persistência | P1/P2 | Fases 1–2 |
| **4 — Memória v2 e automação** | Assistente de verdade: lembra de pessoas/projetos e age sob política | R11 memória, R14 automação/MCP, R17 streaming | P2/P3 | Fases 1 e 3 |
| **5 — Voz e refinamento** | Voz validada, polimento | R15 voz, R16 restante | P3 | Qualquer |

## Dependências

```
R05 ─┬─► R07 ─┐
R04 ─┼────────┼─► R01 ─► R03 ─► R13 ─► R14
R08 ─┘        │      └─► R02 ─┘
              └─► R06 ─► R11
R01 ─► R19    R01 ─► R10 ─► R17
R08,R09 ─► R18      R12, R20: independentes (cedo)
```

## Primeira etapa de implementação (proposta)

**Fase 0, em quatro entregas pequenas e independentes, nesta ordem:**

1. **R05 Backup/restauração da memória** — rede de segurança para tudo que vem depois.
   - Feito quando: restauração em banco limpo confere por hash; rotina agendada com alerta.
2. **R04 Auditoria encadeada** — sem ela, aprovações não são comprováveis.
   - Feito quando: adulteração de linha é detectada; comando e aprovador são registrados.
3. **R07 Dados de runtime fora do git** — começando por cookies, `bans.json`, `user_pc_specs.json` e auditorias; bancos depois do backup. Requer decisão explícita do dono sobre `git rm --cached`.
   - Feito quando: `git status` limpo após uso normal.
4. **R08 Supervisão no Windows** — auto-start, watchdog em `/v1/health`, verificação do `tailscale serve`.
   - Feito quando: reboot do PC recoloca Yui e Tailscale no ar sozinhos.

Estimativa de esforço relativo: R05 pequeno, R04 pequeno–médio, R07 pequeno, R08 pequeno–médio. Sem mudança em comportamento voltado ao usuário.

## Estado em 10/11/2026

Conferido no código da árvore de trabalho (inclui o que ainda não foi commitado). Testes marcados "rodado" foram executados offline nesta revisão.

| Rec. | Estado | Evidência | Falta para o "Feito quando" |
|---|---|---|---|
| R05 Backup | **Implementada** (`271a6a9`) | `src/core/memory/backup.js` (XChaCha20-Poly1305, rotação `YUI_BACKUP_MAX_KEEP`, hash, alerta ao dono em falha); `scripts/backup-memory.mjs`, `scripts/restore-memory.mjs`; `test:backup` 6/6 (rodado) | Rotina agendada: nenhum cron em `scheduler.js` nem tarefa do Windows roda o backup. Destino e chave fora do notebook (decisão 3) |
| R04 Auditoria | **Implementada** (`271a6a9`) | `src/core/audit.js`: hash encadeado, `verifyAudit()`, rotação, alerta em falha de gravação; aprovação registra comando, caminho e aprovador (`src/core/dev/index.js:161-176`); `test:audit` 8/8 (rodado) | Verificação periódica (`verifyAudit()` só roda nos testes); cópia fora do diretório do projeto |
| R07 Dados fora do git | **Não executada** | Roteiro e proposta em `docs/ROTEIRO_DADOS_RUNTIME_GIT_R07.md` e `docs/PROPOSTA_GITIGNORE_R07.md`; bancos, cookies e `bans.json` seguem rastreados e modificados (`git status`). Mitigação parcial: `scripts/atualizar-yui.ps1` não sobrescreve esses arquivos no notebook | Decisão 2 do dono e o `git rm --cached` |
| R08 Supervisão | **Parcial** | Notebook (desde 03/11/2026): tarefas SYSTEM no boot `YuiBot` (laço que religa `node src/index.js` 15 s depois de sair) e `YuiWebApp` (`scripts/instalar-tudo-offline.ps1:147-169`); `YuiAtualizar` diária (`scripts/atualizar-yui.ps1`: baixa o `main`, preserva `.env`/bancos/logs, reinicia e volta a versão anterior se a Yui não subir). Watchdog por `/v1/health`, verificação do `tailscale serve` e rotação de logs em `scripts/yui-supervisor.ps1` (+ `instalar-supervisor-windows.ps1`, com `-DryRun`), **não instalado no notebook** | Watchdog por saúde (processo travado sem sair não é detectado); adaptar o supervisor para não iniciar um segundo `node` ao lado do `YuiBot`; verificação do Tailscale. "Sobe sozinha após reboot" já vale no notebook |
| R01 Política | Só especificação | `docs/ESPECIFICACAO_MOTOR_POLITICAS_FASE1.md`; não existe `src/core/policy` | Toda a implementação (Fase 1) |
| Demais (R02, R03, R06, R09–R20) | Não iniciadas | Nada novo no código para elas | — |

Entregas fora das fases, já no código: DM só com o dono (`dd96b15`, `test:dmowner`); imagem por conversa, Porta I (`271a6a9`, `test:imageintent`); memória e resumo por conversa, Portas N e R (`d29d29b`, `test:chatintents`; ligadas ao `llmHandler.js` em 10/11/2026); biblioteca por conversa, Porta B (não commitada: `src/handlers/libraryIntent.js`, `src/services/bdsLibrary.js`, `test:library`); contorno do defeito da `@discordjs/ws` na reconexão (não commitado: `src/discord/gatewayGuard.js`, `test:discordreconnect`; ver `GAPS_E_DEBITOS_TECNICOS.md` §7).

## Riscos do plano e mitigações

| Risco | Mitigação |
|---|---|
| Regressão na Yui pública ao unificar pipeline (R10) | Atrás de flag; suítes atuais; manter `legacy-chain` até paridade |
| Perda de memória ao migrar esquema (R11/R06) | R05 antes; migração reversível; teste de restauração |
| Histórico do git ainda contém dados removidos (R07) | Avisar o dono; avaliar rotação de cookies/segredos já publicados; reescrever histórico só com decisão explícita |
| Política nova bloqueia uso legítimo | Alias `allow/ask/deny`, modo observação (só registra) antes de impor |
| Chave de backup perdida | Guardar fora do PC/repo; cópia offline; teste de restauração periódico |
| Dependência do PC (offline se desligar) | Aceito pela decisão de produto; documentar RTO e alertas. Desde 03/11/2026 o núcleo é o notebook dedicado (4 GB de RAM, Wi-Fi): queda de rede de ~40 min em 10/11/2026, com reconexão automática |
| Atualização diária instala o `main` sem rodar testes (`scripts/atualizar-yui.ps1`) | A volta de versão só olha se o processo ficou de pé 45 s; rodar a suíte offline antes de cada push no `main` (R20) |
| Defeito da `@discordjs/ws` 1.2.3 na reconexão | Contorno em `src/discord/gatewayGuard.js` + filtro em `src/core/alerts.js`; remover ao migrar para discord.js 15 / `@discordjs/ws` 2.x (`GAPS_E_DEBITOS_TECNICOS.md` §7) |

## Critérios de saída por fase

- **Fase 0:** backup restaurável, auditoria verificável, árvore git limpa, Yui sobe sozinha após reboot.
- **Fase 1:** teste por linha da matriz verde; aprovação remota rejeitada em nível crítico; nenhum `shell:true`.
- **Fase 2:** aprovação crítica só pela UI nativa; APK em aparelho físico; nenhum segredo em texto puro.
- **Fase 3:** Core inicia sem `discord.js`; Discord e app usam o mesmo Agent; uma cadeia de provedores.
- **Fase 4:** consulta por pessoa/projeto funciona; tarefa automatizada executa sob política e é auditada.
- **Fase 5:** voz testada em call real; documentação raiz consolidada.

## Decisões que dependem do dono

1. Aprovar a Fase 0 e a ordem das quatro entregas.
2. Autorizar `git rm --cached` de bancos/cookies/auditorias (e o que fazer com o histórico já publicado).
3. Onde guardar backups e a chave (disco externo? outro PC na tailnet?).
4. Trazer o projeto Electron para `apps/desktop` ou mantê-lo separado.
5. Valores padrão da matriz (§3 de `MATRIZ_DE_PERMISSOES.md`), em especial git push, envio de mensagens e instalação de software.
6. Conferir o `.env` real: memória e contexto ligados? (divergência código × documentação).
7. (10/11/2026) No notebook: manter só o laço do `YuiBot` ou instalar um watchdog por `/v1/health` (o `scripts/yui-supervisor.ps1` atual inicia o próprio `node` e precisaria ser adaptado para não duplicar a Yui).
