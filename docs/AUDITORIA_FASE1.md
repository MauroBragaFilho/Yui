# Auditoria e fechamento da Fase 1: relatório técnico

Data: 2026-11-16. Escopo: código em `D:\Projetos\Yui` (commit base `75686cd` mais as 2 correções descritas na seção 6).
Método: leitura do código por três auditorias independentes (Discord e handlers; API, Core Agent e Código; ações automáticas, segredos e Git), com os achados mais graves reconferidos à mão, mais execução real das suítes de teste.
Nada foi feito em produção: nenhum deploy, nenhuma mudança de `.env`, nenhum dado apagado, nenhum histórico reescrito, `enforce` desligado.

## 1. Conclusão

**A Fase 1 NÃO pode ser considerada concluída.** O motor central (matriz, motor de políticas, tickets, canal local) está implementado, testado e correto no que cobre, mas **cobre só duas superfícies**: as ferramentas do Agent (`/v1/agent`) e o módulo Código (`/v1/dev`). Todo o resto que escreve, executa, bane, baixa ou altera configuração passa por checagens próprias (dono, `ManageGuild`, etc.) e **não consulta o motor nem o `YUI_READ_ONLY`**. Além disso o motor está em `observe`: mesmo nas duas superfícies cobertas ele não impõe nada hoje.

O que está sólido: nenhum caminho remoto aprova um ticket crítico (o app Android nunca chama `/v1/dev/*`).

## 2. Matriz de cobertura (resumo)

Legenda: **Motor** = passa por `policyEngine`/`approvalManager`. **RO** = respeita `YUI_READ_ONLY`. Detalhes linha a linha (arquivo:linha) estão nos relatórios das três auditorias, resumidos aqui por área.

| Área | Operações que escrevem/executam | Motor | RO | Aprovação | Teste |
|---|---|---|---|---|---|
| Agent do chat (`/v1/agent`) | `commands.run`, `apps.open`, `projects.open`, `system.info`, `files.search`, `commands.list`, skills | **sim** (observe; `enforce` impõe) | sim (`checkToolAccess`) | confirmação 2 min; crítico por ticket só em `enforce` | `test-core-agent`, `test-security-policy` |
| Módulo Código (`/v1/dev`) | `write_file`, `apply_diff`, `run_terminal` | **sim** (nível via motor; ticket) | sim | ticket CRÍTICO, aprovado só no canal local | `tests/dev/*`, `test-approvals` |
| Aprovação crítica | decide/consume | sim | n/a | só `LOCAL_PC` (canal 127.0.0.1:3940 + segredo) | `test-approvals` (19) |
| API admin (`/v1/admin/*`): banir, apagar memória de terceiros, trocar chaves e provedores de IA, canais, inscrições, reiniciar, DM | muitas | **não** | **não** | `confirm` enviado pelo próprio cliente | `test-panel` (caminho feliz e 403 de MEMBER) |
| Memória (`/v1/memory*`) | gravar, apagar um, apagar tudo | **não** (matriz tem `memory.*` sem chamador) | não | nenhuma (matriz diz ASK em `wipe_own`) | `test-core-api` (só feliz) |
| BDS (upload, apagar, purge, renomear) | sim | **não** | não | `confirmar` vem do cliente | `test-bds-proxy` |
| Discord: ban/desban/apelação/auto-ban/`ia_automod` | sim | **não** | não | dono (checagem própria); auto-ban sem humano | `test-permission-gaps` (parcial) |
| Discord: `/yui-servidor`, `/yui-ferramentas`, `/yui-criador`, `/yui-config_ia`, painel `bot_config` | grava config | **não** | não | `ManageGuild`/`ManageChannels`/dono | `test-embed-*` (limites de embed; sem negação) |
| Discord: `/baixar_*`, `/yui-imagem`, rádio, `/sair-call` | rede, yt-dlp, ffmpeg, temp | **não** | não | nenhuma além de não estar banido | parcial |
| Memória no Discord (`/yui-memoria`, captura automática) | grava/apaga | **não** | não | o próprio autor | `test-context`, `test-core` |
| Automáticos: lembretes (DM), relatório matinal e de saúde, alertas, publicações em canais públicos | sim | **não** | não | n/a (agendados) | vários |
| Automáticos: limpezas de arquivos, atualização de `yt-dlp.exe`, download de binários, downloads que sobrescrevem `src/data/*` | sim | **não** | não | n/a | em geral nenhum |
| Infra do notebook: `YuiAtualizar` (SYSTEM, executa código do `main`), `YuiBackup`, watchdog | sim | n/a | n/a | push no `main` = deploy | parcial |

## 3. Vulnerabilidades e riscos encontrados

Gravidade pela leitura do código; os marcados **[verificado]** foram reproduzidos na minha execução.

### Alta
1. **O motor e o `YUI_READ_ONLY` não cobrem a superfície Discord, a API admin, o BDS nem os jobs automáticos.** Hoje `READ_ONLY=true` dá falsa sensação de segurança: um token de dono roubado ainda bane, apaga memória de terceiros, apaga arquivos do BDS, reinicia, troca chaves de IA e provedores.
2. **Aprovação crítica no Android na prática, se `READ_ONLY=false` em `observe`:** `commands.run` e `apps.open` executam com um simples `POST /v1/agent/confirm`, sem ticket nem canal local. Mascarado hoje porque `READ_ONLY=true`.
3. **Redirecionamento do tráfego de IA:** `POST /v1/admin/ai/custom` aceita qualquer `baseUrl` https; qualquer token de dono pode enviar os prompts a um servidor externo. `YUI_PANEL_AI_EDIT` vem `true`.
4. **Repositório público com dados privados versionados [verificado `visibility: PUBLIC`]:** `database/*.db` (IDs de servidor/canal), logs de auditoria (`apps/yui-app/logs/core-audit.jsonl`, 2370 linhas com IDs de usuário e comandos), `src/data/*.json` (bans, usuários vigiados, presença, specs de PC), `reddit-cookies-cache.json` (cookies de sessão do Reddit; as claims indicam sessão anônima já expirada, risco real baixo).
5. **Cadeia de suprimentos do atualizador:** push no `main` público vira execução de código como SYSTEM no notebook (preflight, `npm install`), sem commit fixado, assinatura nem hash. O único controle é a conta do GitHub.
6. **Leitura de segredos pelo módulo Código [verificado e CORRIGIDO]:** `secrets/ai-providers.json` e `secrets/approval-channel.json` passavam em `isSensitive` (só nome de arquivo era checado). Com o projeto Yui cadastrado, qualquer token de dono lia as chaves de IA e o segredo do canal local pela rota de arquivo.
7. **Ban automático global sem humano:** `ia_automod` (decisão do LLM, padrão `both` em todo servidor novo, prompt com mensagens de terceiros) e auto-ban por substring sem fronteira de palavra em nome de servidor/canal (`pinto`, `1488` casam em nomes inocentes). `bans.json` corrompido zera os bans e é sobrescrito.

### Média
8. **Gravar arquivo sem aprovação via `git diff|log|show --output=...` [verificado e CORRIGIDO]:** passava como comando "safe". Também `--no-index`.
9. **`.GIT`/`NODE_MODULES` com caixa diferente em arquivo novo** podem escapar do `assertWritable` no NTFS (análise estática, não reproduzido; ainda exige ticket crítico).
10. **`isLocalRequest` (5 cabeçalhos) é mais fraco que o filtro do canal local (9)**; faltam `x-real-ip`, `via`, etc.; não olha `Origin`/`Host`.
11. **Canal local:** qualquer processo do mesmo usuário lê `secrets/approval-channel.json` e se autoaprova (inclusive via comandos "safe" como `npm test`); janela entre gravar o arquivo e aplicar a ACL no Windows; `'C:\Windows'` com escape inválido no fallback de `localChannel.js:47`.
12. **Aprovação sobre pré-visualização truncada:** o hash cobre tudo, mas a CLI mostra ~12 linhas.
13. **Autenticação da API:** sem limite para Bearer inválido; tokens estáticos só exigem 16 caracteres e não expiram; `ctx.role==='BLOCKED'` é código morto (`buildContext` sem `isBlocked`); painel web monta `http://` e o token trafega em texto puro na LAN; bloqueios globais permitem travar o dono.
14. **Discord:** `!interaction.guild ||` libera a checagem de permissão em DM (`/yui-servidor` pode gravar `serverSettings["null"]`); `/yui-configurar`, `/yui-seguir-*`, `/yui-parar-seguir` só têm `setDefaultMemberPermissions` (sem checagem em runtime); `/yui-imagem` usa `bypassSafety:true` sem cota; botão `compress_video_*` sem dono/ban/papel; `/sair-call` para qualquer membro; ban só vale em slash/menção/prefixo, não em botões/selects/modais; prefixo `+yui` não passa pelo gate de ToS; ferramentas com efeito (`download_*`, `ia_automod`) disponíveis em conversa espontânea.
15. **Binários baixados sem checksum** (`yt-dlp.exe` diário, `ffmpeg`); dados externos sobrescrevem `src/data/*` no boot sem validar esquema.
16. **Webhook de avisos envia prompt/resposta de terceiros sem `redact`.**
17. **BDS:** `caminho` e `confirmar` vêm do cliente; upload sem teto do lado da Yui.
18. **Puppeteer `--no-sandbox`** em 4 pontos, rodando como SYSTEM.
19. **Estado de runtime gravado dentro da árvore versionada** (`weekly/cache.json`, `reddit-cookies-cache.json`); os arquivos de `src/data` fora da lista de exclusão do atualizador são sobrescritos pelo valor do repositório a cada deploy.

### Baixa
`/v1/health` público revela `readOnly`/backends; `restoreMemoryBackup` sem checar `..` no manifesto; spawn de `git/python` no Windows pode procurar o executável na pasta do projeto (não verificado); lembretes por DM a terceiros pelo dono; duas fontes de "dono" (`config.isOwner` e `isOwnerId`); ban/config sem eventos de auditoria na superfície Discord.

## 4. Regra de memória (item 3): **divergência encontrada**

- Código: padrão 30 dias; dono permanente; `MEMORY_RETENTION_DAYS=0` ou `permanente` torna a memória de TODOS permanente (`src/core/memory/store.js:19-36`). Limpeza diária às 05:30 UTC (`scheduler.js:63-71`, `purgeExpired`). Memória em bancos separados por escopo (`database/memory-*.db`, ignorados pelo Git).
- `.env` do PC: `MEMORY_RETENTION_DAYS=30` (conforme a regra).
- **`.env` do notebook (produção): `MEMORY_RETENTION_DAYS=0`**, ou seja, a memória dos demais usuários do Discord **não expira**. Isso contraria a regra "demais usuários: 30 dias". Existe uma decisão anterior registrada em `docs/PLANO_ASSISTENTE_PESSOAL.md` (item 5 da seção 3, "manter permanente"). **Decisão do dono em 2026-11-17: manter permanente (`0`) em produção.** A regra dos 30 dias para os demais usuários fica suspensa por essa decisão expressa; nada foi alterado no `.env`.

## 5. Testes executados (resultados reais)

| Verificação | Resultado |
|---|---|
| `npm run test:ci` (34 suítes offline, incluindo `test:core`, `test:core-agent`, `test:security`, `test:approvals`, `test:readonly`, `test:permgaps`, `test:memperm`, `test:hybrid`, `test:dmowner`, `test:dev`...) | 34/34 OK, rodada final feita DEPOIS das correções da seção 6 |
| `npm run test:security` | 12 testes OK |
| `npm run test:approvals` | dentro da CI: OK (19 testes) |
| `npm run test:dev` (módulo Código, `node --test`) | antes das correções 70/70; depois, 72/72 (2 negativos novos) |
| Testes do aplicativo (`apps/yui-app`, `npm test`) | 58/58 passaram |
| TypeScript (`apps/yui-app`, `npm run typecheck` = `tsc --noEmit`) | sem erros |
| `git fsck --no-dangling` | sem problemas (exit 0) |

**Não rodados**: testes que dependem de Discord/rede/chaves reais e `test:atualizarpainel`/`test:supervisor` (PowerShell); testes de regressão do Discord existem só como testes de limites de embed (`test-embed-*`, `test-interaction-limits`); não há nenhum teste de negação de permissão para os handlers do Discord (lacuna).

Lacunas de teste identificadas: negação de permissão nos handlers Discord (`adm_*`, `banlist_*`, `/yui-imagem`, `/sair-call`, ToS, `/yui-configurar`); `READ_ONLY` bloqueando rota admin/BDS; Bearer inválido repetido; `YUI_DEV_APPROVAL=auto` com `observe`; `x-real-ip` em `isLocalRequest`; `.GIT`/`NODE_MODULES` em caixa diferente; `startScheduler`/`minutesToCron`; downloads de `src/data`; preflight e rollback do atualizador.

## 6. Correções feitas nesta etapa (pequenas, só no repositório local, sem commit)

| Arquivo | Mudança | Teste |
|---|---|---|
| `src/core/dev/workspace-fs.js` | `isSensitive` passa a bloquear pastas inteiras `secrets/`, `.git/`, `.ssh/`, `.gnupg/` (não bloqueia `src/secrets.js` nem `src/database/`) | `tests/dev/terminal-sanitizer.test.js` (negativo novo) |
| `src/core/dev/terminalSanitizer.js` | `git ... --output[=...]` e `--no-index` bloqueados | idem |

## 7. Arquivos que precisam de correção para fechar a Fase 1

1. Cobertura pelo motor: criar linhas na matriz e chamadas a `gate()` em `src/core/api/admin.js` (todas as rotas), `src/core/api/bds.js`, `src/core/api/server.js` (`/v1/memory*`), `src/handlers/creatorAdminHandler.js`, `banHandler.js`, `serverAdminHandler.js`, `configPanelHandler.js`, `mcpToolPanelHandler.js`, `src/events/interactionCreate.js`, `src/discord/commands/*.js` (setup, seguir, parar), `src/handlers/llmHandler.js` (`ia_automod`, `download_*`, `join_voice_call`).
2. `YUI_READ_ONLY` nas rotas admin/BDS/Discord e nos jobs que apagam ou baixam.
3. `src/core/api/server.js`: limite para Bearer inválido, `isBlocked`, token mínimo mais forte; `src/core/dev/routes.js`: `isLocalRequest` com a mesma lista do canal local.
4. `src/core/aiSettings.js`/`admin.js`: `baseUrl` custom só por aprovação local (ou lista de hosts).
5. `src/core/dev/workspace-fs.js`: caso-insensível para `.git`/`node_modules`/`.yui` em arquivo novo.
6. `src/core/security/localChannel.js`: criar o arquivo já com ACL (ou escrever após restringir a pasta); corrigir `'C:\\Windows'`.
7. `src/handlers/banHandler.js`: fronteira de palavra; `bans.json` corrompido não pode zerar/sobrescrever; `llmHandler.js`: `ia_automod` com confirmação humana.
8. `scripts/atualizar-yui.ps1` e `src/utils/binaries.js`: fixar commit/hash e checksums.
9. Runtime fora do Git (`git rm --cached`, só índice) e mover estado do Weekly para fora de `src/`.

## 8. Pendências para fechar a Fase 1

1. Decidir a retenção de memória em produção (seção 4).
2. Cobrir (ou conscientemente excluir, com justificativa) cada linha da seção 2 marcada "não".
3. Corrigir os itens altos 1 a 7 da seção 3.
4. Criar os testes negativos da seção 5 (lacunas).
5. Validar `enforce` em ambiente de teste e só então propor a ativação.

## 9. Plano de ativação e rollback (sem executar)

Ativação em etapas, cada uma com evidência antes da próxima:
1. Deixar `observe` rodando no notebook por alguns dias; revisar na auditoria os eventos `policy.evaluate` com `diverges` preenchido; corrigir a matriz ou o código onde a divergência não for intencional.
2. Em ambiente de testes (cópia local com `.env` próprio, `YUI_POLICY_MODE=enforce`, `YUI_READ_ONLY=false`, sem tokens reais): provar que (a) `commands.run` por origem REMOTE é negado; (b) por LOCAL_PC gera ticket e só executa após `yui-aprovar`; (c) ticket reutilizado, adulterado ou expirado falha; (d) o app remoto não aprova crítico. Anexar a saída dos testes.
3. Regressões: `npm run test:ci`, `npm run test:dev`, testes do app e `tsc`.
4. Só com sua autorização expressa: `YUI_POLICY_MODE=enforce` no `.env` do notebook, reinício do `YuiBot`, observar 24 h. `YUI_READ_ONLY` continua `true` até o fim.
5. **Rollback:** remover/colocar `YUI_POLICY_MODE=observe` (ou apagar a linha) no `.env` e reiniciar o `YuiBot` (tarefa agendada); não exige deploy. Reverter o código seria `git revert` do commit e push (o atualizador aplica); o `.env.bak-*` guarda a versão anterior do `.env`.

## 10. Proteção do projeto: resumo

**Feito em 2026-11-17 (autorizado):** `git rm --cached` (só índice) dos bancos `database/*.db`, logs de auditoria, `src/data/*.json` com dados de usuário/estado, cookies do Reddit e cache do Weekly, mais regras no `.gitignore`. Os arquivos continuam no disco; o atualizador copia sem apagar, então o notebook não perde nada, e deixa de sobrescrever `server_settings.json` e afins a cada deploy. O histórico público NÃO foi reescrito.

- Versionados e públicos: bancos `database/*.db`, logs de auditoria, `src/data/*.json` com dados de usuário, `reddit-cookies-cache.json`, `weekly/cache.json` (lista na seção 3, item 4 e no relatório de segredos). Nenhum `.env`, chave privada, `secrets/` ou `.pem` no histórico (399 commits verificados).
- Histórico: `git fsck` sem erros. **Dados já estão no histórico público**; remover do índice não os tira do histórico. Reescrever histórico (`filter-repo`) e/ou tornar o repositório privado exige sua autorização; recomendo no mínimo `git rm --cached` + `.gitignore` e considerar privar o repositório (o atualizador baixa o zip do `main`: ele precisaria de credencial).
- Backup: cifrado, enviado a repositório privado; `StrictHostKeyChecking=accept-new` e `safe.directory=*`; falta teste de ponta a ponta e a tarefa `YuiBackup` não está versionada.
