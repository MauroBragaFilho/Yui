# AUDITORIA_TECNICA — Yui rumo a Assistente Pessoal

Data: 2026-11-05 · Escopo: leitura do repositório `D:\Projetos\Yui` · Código, bancos e memórias **não foram alterados** · Nenhum segredo reproduzido.
Documentos relacionados: `ARQUITETURA_ATUAL.md`, `ARQUITETURA_PROPOSTA.md`, `GAPS_E_DEBITOS_TECNICOS.md`, `ROADMAP_EVOLUCAO.md`, `MATRIZ_DE_PERMISSOES.md`.

## 1. Diagnóstico objetivo

**O que a Yui já possui.** Um Core real (`src/core`) com papéis, escopo de memória decidido pelo backend, memória permanente do dono e temporária (30 dias) dos demais, persona por contexto, Agent com ferramentas somente leitura, AI Manager com 3 backends, Gateway de IA com failover, API autenticada, app Expo com telas ligadas à API, aba Código com aprovação humana local, módulo de voz (TTS) e uma infraestrutura Discord extensa (GTA, mídia, moderação). As decisões de produto (memória do dono permanente, retenção temporária dos outros, PC como núcleo, Tailscale) **já estão implementadas ou documentadas no código**.

**O que realmente funciona (verificado nesta auditoria):** `node tests/test-core.js` → 21 testes OK; `npm test` do app → 23 aprovados. O restante é afirmado pela documentação (≈2.900 verificações offline) e **não foi reexecutado**. Nenhum componente foi observado em execução real.

**O que precisa ser corrigido:** (1) defesa "local × remoto" baseada em ausência de cabeçalhos; (2) terminal com `shell:true` e lista negra; (3) auditoria mutável e sem o comando aprovado; (4) token do app em texto puro; (5) ausência de backup da memória permanente; (6) persistência síncrona e sem lock entre processos; (7) bancos, cookies e auditorias de runtime versionados no git; (8) sem auto-start/watchdog no Windows.

**O que falta desenvolver:** política única com os quatro estados; memória com entidades (pessoas/projetos), busca melhor e episódica; Agent no Discord via Core; automação (tarefas agendadas sob política); app Android construído; aprovação nativa no Desktop; transporte MCP; streaming; STT/voz validados em chamada real.

**Primeira etapa recomendada:** **Fase 0 — Fundação segura** (sem funcionalidade nova): backup/restauração da memória, tirar dados de runtime do git, auditoria encadeada, auto-start + watchdog + verificação do Tailscale. É de baixo risco, protege o que já existe e é pré-requisito para dar autonomia à Yui. Em seguida, **Fase 1 — Motor de política de 4 estados** (`MATRIZ_DE_PERMISSOES.md`).

## 2. Auditoria arquitetural (resumo)

Ver `ARQUITETURA_ATUAL.md`. Pontos-chave:
- Core desacoplado do Discord **no código**, mas não **no padrão de execução** (`legacy-chain` carrega `llmHandler.js`, `manager.js:142,400`).
- Dois sistemas de política, duas cadeias de provedores de IA, três históricos, `llmHandler.js` com 4302 linhas.
- Processo único para bot, API, Gateway e scheduler.
- O Agent do Core só atende a API; o Discord tem pipeline próprio.

## 3. Auditoria funcional

Matriz completa em `GAPS_E_DEBITOS_TECNICOS.md` §1. Resumo:

| Estado | Itens |
|---|---|
| Implementada e funcional | Permissões, memória dono/usuário, `/yui-memoria`, AI Manager, Gateway, Agent (leitura), API, app web, scheduler, engines |
| Parcial | Captura de memória (3 regex), busca de memória, ponte MCP, aba Código (modelo real não confirmado), voz (call real não confirmada) |
| Presente, não integrada | Agent no Discord; limpeza de contexto ao banir/sair de servidor; papéis TRUSTED/GUEST |
| Simulada / provisória | `dev:api --fake`; testes com dublês (Discord, buscadores, IA) |
| Planejada | Embeddings, memória episódica/semântica, entidades, backup, ferramentas `write`, SSE, push, APK, recados ao dono, Yui Desktop dentro do repo |

Critério aplicado: uma tela, classe, endpoint ou documento **não** conta como funcionalidade concluída sem evidência no código ou em teste.

## 4. Auditoria de memória

| Aspecto | Achado |
|---|---|
| Dono, permanente | `memory-personal`, `expires_at` NULL (`store.js:73`); escopo só em DM/canal privado (`permissions.js:69-71`) |
| Usuários, temporária | `memory-discord`, 30 dias **deslizantes** (renovados a cada interação, `store.js:50-59`); purge diário 05:30 UTC |
| Organização | Tabela única `memories` (tipos fact/preference/project/decision/summary/note, tags, importância 1–5); `memory_users` no banco Discord; **sem entidades** pessoa/projeto/relação |
| Busca | Léxica por tokens, `LIKE`, pontuação `hits*3+importância+recência`, 200 linhas recentes, devolve 8 (`store.js:97-123`); sem FTS5/embeddings |
| Escrita | 3 regex na fala do usuário + `/yui-memoria`; dedup em JS (500 linhas); **sem sumarização automática** |
| Contexto entre conversas | Contexto por horas existe mas **desligado**; por canal, não por interface; a API usa `Map` em RAM; memória de longo prazo vale entre interfaces se o `userId` coincidir (**não verificado** como o app resolve o id) |
| Persistência | sql.js em RAM; regrava arquivo inteiro de forma atômica (tmp+rename, `db.js:100-175`); sem WAL/fsync; fallback de gravação direta |
| Backup/restauração/retenção | **Inexistentes** para memória; `historico.txt` sem retenção; arquivos `.corrupt-*` do contexto por 48 h |
| Semântica/episódica | Viável: manter sql.js, adicionar tabelas e (quando houver IA local) embeddings; ver `ARQUITETURA_PROPOSTA.md` §4 |
| Divergência | Código assume memória **desligada** sem variável (`discordAdapter.js:16`); doc de ambiente mostra `true`. Conferir o `.env` real |

**Regra preservada:** dono = permanente e em banco separado; demais = retenção temporária. Nenhuma recomendação altera isso.

## 5. Auditoria de segurança e autonomia

Detalhes e matriz em `GAPS_E_DEBITOS_TECNICOS.md` §2 e `MATRIZ_DE_PERMISSOES.md`.

- **Autenticação:** Bearer estático (≥16 caracteres) ou sessão (12 h, máx. 20, em memória, sha256) por senha scrypt ou chave de uso único de 5 min via DM; comparação em tempo constante; bloqueio global após 5 falhas.
- **Autorização:** papel resolvido pelo backend; painel e `/v1/dev/*` só OWNER; modo somente leitura por padrão; deny por padrão.
- **Execução/arquivos:** sem shell livre no Agent; no módulo Código, `allow/ask/deny` com aprovação **local** e modo remoto somente leitura; `workspace-fs` com `path.relative`+`realpath`, arquivos sensíveis por nome, backups e gravação atômica.
- **Credenciais:** `.env`, `secrets/`, `*.pem` fora do git e sem histórico; processos filhos sem variáveis TOKEN/KEY/SECRET/PASSWORD/COOKIE/ARL; cifragem de `secrets/ai-providers.json` **não comprovada**; token do app em texto puro.
- **Acesso remoto:** API em `127.0.0.1`, TLS via `tailscale serve`, `funnel` proibido; o servidor não faz TLS; `YUI_API_HOST` não-loopback só gera aviso.
- **Auditoria:** JSONL append por convenção, sem encadeamento, rotação ou permissão restrita; não registra o comando aprovado nem quem aprovou.
- **Isolamento:** essencialmente single-owner; `activeRun` global.
- **Conclusão:** a base é boa para um dono único com aprovação humana; para autonomia configurável falta um motor de política único, aprovação crítica ligada ao PC físico e auditoria à prova de adulteração.

## 6. Recomendações (cada uma com os 7 campos)

Prioridade: P0 = antes de ampliar autonomia; P1 = próxima fase; P2 = médio prazo; P3 = oportunidade.

### R01 — Motor de política único com 4 estados
- **Problema:** `permissions.js` (access/confirm) e `dev/policy.js` (allow/ask/deny) coexistem sem vocabulário comum; não há nível crítico.
- **Evidência:** `policy.js:69-92`; `permissions.js:127-152`; `tools.js:250-289`.
- **Solução:** módulo `core/policy` que devolve AUTOMATICO/AUTORIZADO/APROVACAO_CRITICA/BLOQUEADO (`MATRIZ_DE_PERMISSOES.md`), com `allow/ask/deny` como alias; Discord, API, Agent e Código passam por ele.
- **Dependências:** R04 (auditoria), R02 (prova de origem).
- **Risco técnico:** Médio — toca todos os pontos de execução; mitigar com migração por adaptador e vigia de código.
- **Prioridade:** P0.
- **Critério de conclusão:** testes por linha da matriz passam; nenhuma ferramenta executa sem consultar a política (vigia automatizado); comportamento atual preservado (suítes existentes verdes).

### R02 — Prova de origem local sem depender de cabeçalhos
- **Problema:** "local" = loopback sem cabeçalhos de proxy; um proxy local sem esses cabeçalhos faria o celular aprovar/gravar.
- **Evidência:** `dev/routes.js:22-33`; `dev/index.js:231`.
- **Solução:** canal de aprovação separado e autenticado (segredo/dispositivo registrado no PC, ou socket/porta distinta só em loopback usada pela UI nativa do Desktop); `isLocalRequest` vira apenas uma checagem adicional.
- **Dependências:** R13 (UI nativa de aprovação); pode começar com porta de aprovação em loopback dedicada.
- **Risco técnico:** Médio.
- **Prioridade:** P0.
- **Critério de conclusão:** teste simulando proxy local sem cabeçalhos **não** consegue aprovar nível crítico; documentação de operação atualizada.

### R03 — Terminal sem `shell:true` e com plano exato aprovado
- **Problema:** lista negra por regex contornável; `shell:true`.
- **Evidência:** `policy.js:20-35`; `terminal.js:54`; `workspace-fs.js:20` (sensível só por nome).
- **Solução:** executar `argv` sem shell; allowlist de comandos seguros; qualquer outro vira APROVACAO/AUTORIZADO conforme matriz; aprovação presa ao hash do comando; detectar sensível também por conteúdo.
- **Dependências:** R01.
- **Risco técnico:** Médio (compatibilidade com comandos que dependem de shell).
- **Prioridade:** P0.
- **Critério de conclusão:** suíte com payloads de bypass (`powershell -enc`, `python -c`, `cmd /c`, `curl -o`, encadeamento) nunca executa sem aprovação; `shell:true` removido.

### R04 — Auditoria encadeada e completa
- **Problema:** log mutável; sem comando/caminho/aprovador; erros engolidos; sem rotação.
- **Evidência:** `audit.js:27-29`; `dev/index.js:165,236`.
- **Solução:** hash encadeado por linha, campos de `MATRIZ_DE_PERMISSOES.md` §4, verificação periódica, alerta em falha de gravação, rotação/retenção, cópia fora do diretório do projeto.
- **Dependências:** nenhuma (pode ser a primeira entrega).
- **Risco técnico:** Baixo.
- **Prioridade:** P0.
- **Critério de conclusão:** alterar uma linha é detectado por `verifyAudit()`; aprovação registra comando exato e aprovador; teste cobre falha de disco.

### R05 — Backup e restauração da memória (cifrado)
- **Problema:** `memory-personal.db` sem cópia; corrupção = perda.
- **Evidência:** `ASSISTENTE_PESSOAL.md` pendência 4; `.gitignore:13`.
- **Solução:** backup agendado (rotativo) com checagem de integridade, cifrado (`@noble/ciphers` já é dependência), em destino fora do repo; comando de restauração testado; incluir `memory-discord`/contexto conforme retenção.
- **Dependências:** nenhuma.
- **Risco técnico:** Baixo (cuidar da chave: guardada fora do repo, com cópia offline).
- **Prioridade:** P0.
- **Critério de conclusão:** restauração em banco limpo reproduz o conteúdo verificado por hash; rotina agendada com alerta de falha; documentada.

### R06 — Persistência mais segura da memória
- **Problema:** 3 regravações completas por `remember`; sem lock entre processos; fallback não atômico.
- **Evidência:** `db.js:151-175,200-230`; `store.js:50-59`.
- **Solução:** agrupar `remember`+`touchUser` em transação; renovar retenção só quando necessário (por data); lock de arquivo/PID exclusivo; reavaliar SQLite nativo (WAL) com análise comparativa antes de qualquer troca.
- **Dependências:** R05 antes (rede de segurança).
- **Risco técnico:** Médio.
- **Prioridade:** P1.
- **Critério de conclusão:** um `remember` gera uma gravação; segundo processo é recusado ou serializado; `test-db-atomic` e `test-core` seguem verdes.

### R07 — Tirar dados de runtime do git
- **Problema:** bancos, cookies de sessão, bans, specs do PC e auditorias versionados; árvore suja.
- **Evidência:** `git ls-files`/`git status` (database/*.db, `reddit-cookies-cache.json`, `logs/.*-audit.json`, `apps/yui-app/logs/*`, `src/data/{bans,user_pc_specs,watchedUsers}.json`).
- **Solução:** `git rm --cached` + `.gitignore`; sementes (`*.example`) para dados necessários; avaliar rotacionar cookies já publicados. Requer decisão do dono (a doc já a reserva).
- **Dependências:** backup (R05) antes de remover do índice; cuidado: o histórico do git continua contendo os dados.
- **Risco técnico:** Baixo (operacional).
- **Prioridade:** P0 (cookies/bans/auditorias) e P1 (bancos).
- **Critério de conclusão:** `git status` limpo após execução normal; nenhum dado pessoal/sessão rastreado; instruções de bootstrap criam os bancos.

### R08 — Disponibilidade no Windows: auto-start, watchdog, Tailscale
- **Problema:** sem serviço/tarefa de boot, sem watchdog; `tailscale serve` não verificado; processo único.
- **Evidência:** só `scripts/yui.service` (Linux); `OPERACAO.md:51-71`; `/v1/health` sem consumidor.
- **Solução:** Tarefa Agendada (ou NSSM) com reinício em falha; script supervisor que consulta `/v1/health`, reinicia e alerta o dono; verificação/recriação do `tailscale serve` na subida; rotação de logs; política de energia do PC.
- **Dependências:** nenhuma.
- **Risco técnico:** Baixo.
- **Prioridade:** P0.
- **Critério de conclusão:** reiniciar o PC leva a Yui e o `tailscale serve` ao ar sem intervenção; matar o processo (teste controlado, nunca por PID de terceiros) o recoloca em até X segundos com alerta; nenhuma porta exposta fora do loopback/tailnet.

### R09 — Credenciais e tokens
- **Problema:** token do app em texto puro; tokens fixos sem expiração; senha em texto aceita; `ai-providers.json` sem cifragem comprovada; `Yui.pem` na raiz.
- **Evidência:** `storage.ts:8-10,47`; `auth.js:67,76`; `server.js:571`.
- **Solução:** SecureStore/Keychain no Android (e sessão curta na web); expiração e revogação para `YUI_API_TOKENS`; exigir hash scrypt (recusar texto simples); recusar host não-loopback sem TLS; cifrar `ai-providers.json`; mover `Yui.pem` para fora do projeto.
- **Dependências:** R18 (Android) para armazenamento seguro nativo.
- **Risco técnico:** Baixo–Médio (compatibilidade do login atual).
- **Prioridade:** P1.
- **Critério de conclusão:** nenhum segredo em texto puro em disco ou no app; teste cobre expiração/revogação.

### R10 — Core realmente independente e pipeline único
- **Problema:** `legacy-chain` arrasta o Discord; duas cadeias de IA; Agent só na API; `llmHandler.js` monolítico.
- **Evidência:** `manager.js:28-30,142,400`; `llmHandler.js:1319-1900,4302 linhas`.
- **Solução:** extrair provedores para o Gateway (única cadeia), mover pesquisa/segurança para `core/`, fazer o Discord chamar o Core (incluindo Agent), manter `llmHandler` como adaptador fino. Fazer por etapas, sem parar a Yui pública.
- **Dependências:** R01 (política antes de unificar ferramentas).
- **Risco técnico:** Alto (maior superfície de regressão) — executar atrás de flag, com suítes atuais como rede de segurança.
- **Prioridade:** P2.
- **Critério de conclusão:** Core inicia e responde sem importar `discord.js`; Discord e app usam o mesmo `runAgent`; uma única cadeia de provedores; suítes existentes verdes.

### R11 — Memória v2 (entidades, busca, episódica, retenção)
- **Problema:** sem pessoas/projetos/relações; busca limitada; sem sumarização; `historico.txt` sem retenção.
- **Evidência:** `schemas.js`; `store.js:97-123`; pendência 13.
- **Solução:** tabelas `entities` e `links` (pessoa, projeto, decisão ↔ memórias), busca com normalização e índice (FTS se migrar de motor, ou índice invertido próprio), sumarização episódica periódica do contexto, embeddings opcionais quando houver IA local, política de retenção de `historico.txt`; escopo/retenção atuais intocados.
- **Dependências:** R05, R06.
- **Risco técnico:** Médio.
- **Prioridade:** P2.
- **Critério de conclusão:** consulta "o que decidi sobre o projeto X" retorna memórias ligadas; testes de isolamento dono/usuário continuam verdes; migração reversível com backup.

### R12 — Endurecer a borda da API
- **Problema:** bloqueio de login global permite DoS; rate limit só após auth; `/v1/health` expõe detalhes.
- **Evidência:** `auth.js:150-172`; `server.js:332,418`.
- **Solução:** limites por dispositivo/segredo além do global; rate limit pré-auth; health público mínimo e detalhado só autenticado; poda do mapa de limites.
- **Dependências:** nenhuma.
- **Risco técnico:** Baixo.
- **Prioridade:** P1.
- **Critério de conclusão:** testes de abuso não travam o dono legítimo; `/v1/health` público só informa vivo/morto.

### R13 — Yui Desktop com aprovação nativa
- **Problema:** Electron fora do repositório; aprovações nativas do Windows pendentes.
- **Evidência:** `ASSISTENTE_PESSOAL.md` pendência 3 e §6; nenhuma referência a Electron nos `package.json` do repo.
- **Solução:** decidir (com o dono) se o projeto externo entra como `apps/desktop` ou continua separado; implementar diálogo nativo de aprovação ligado ao canal de R02, bandeja, auto-start.
- **Dependências:** R02, R01.
- **Risco técnico:** Médio.
- **Prioridade:** P1.
- **Critério de conclusão:** aprovação crítica só pode ser concedida pela UI nativa no PC; app Desktop sobe com o PC.

### R14 — Automação e MCP sob política
- **Problema:** não há tarefas agendadas do dono nem transporte MCP; MCP externo seria WRITE genérico.
- **Evidência:** `tools.js:318-339`; pendência 2.
- **Solução:** `core/automation` com tarefas (gatilho + plano) que passam pela política; cliente MCP (stdio) com cada ferramenta classificada individualmente; sem privilégios irrestritos.
- **Dependências:** R01, R04, R13.
- **Risco técnico:** Médio–Alto.
- **Prioridade:** P2.
- **Critério de conclusão:** tarefa criada pelo dono executa na hora com estado correto da matriz; ferramenta MCP nova começa APROVACAO_CRITICA; tudo auditado.

### R15 — Voz validada
- **Problema:** TTS testado só offline; STT não verificado; call real pendente.
- **Evidência:** pendência 16; `src/services/tts/*`; `sttService.js`.
- **Solução:** checklist de `OPERACAO.md §11` em call real; definir voz no app/Desktop só depois.
- **Dependências:** nenhuma.
- **Risco técnico:** Baixo.
- **Prioridade:** P3.
- **Critério de conclusão:** teste em call real documentado, com falhas conhecidas listadas.

### R16 — Higiene do repositório
- **Problema:** `.env_example` duplicado/desatualizado; `Yui.bat`/`yui.bat`; `.gitignore` contraditório; config duplicada; `convert-to-esm.js`; docs soltas na raiz; persona legada.
- **Evidência:** ver `GAPS_E_DEBITOS_TECNICOS.md` §5 (T6–T9, T13).
- **Solução:** consolidar sem remover recurso em uso: arquivar (não apagar) o que for legado, após confirmação do dono.
- **Dependências:** nenhuma.
- **Risco técnico:** Baixo.
- **Prioridade:** P3.
- **Critério de conclusão:** um único exemplo de `.env`, `.gitignore` coerente, documentação raiz referenciando `docs/content_pt`.

### R17 — Streaming (SSE)
- **Problema:** respostas só aparecem inteiras.
- **Evidência:** pendência 1.
- **Solução:** SSE em `/v1/chat`/`/v1/agent` e consumo no app.
- **Dependências:** R10 parcial (backend único).
- **Risco técnico:** Baixo–Médio.
- **Prioridade:** P3.
- **Critério de conclusão:** primeiro token no app antes do fim da geração; cancelamento funciona.

### R18 — Android construído e instalado
- **Problema:** nunca houve prebuild/APK; HTTPS exigido fora do Expo Go.
- **Evidência:** `app.json` sem pasta `android/`; `apps/yui-app/README.md:100`.
- **Solução:** EAS ou prebuild local, APK assinado, notificações (alertas do dono), armazenamento seguro (R09).
- **Dependências:** R08 (acesso estável), R09.
- **Risco técnico:** Médio.
- **Prioridade:** P2.
- **Critério de conclusão:** APK instalado em aparelho físico conecta via Tailscale e conversa; recebe alerta de teste.

### R19 — Runs do módulo Código por sessão
- **Problema:** `activeRun` global; qualquer sessão OWNER controla qualquer run.
- **Evidência:** `dev/index.js:130,217-221`.
- **Solução:** mapa de runs por sessão/dono; cancelar/aprovar só o próprio.
- **Dependências:** R01.
- **Risco técnico:** Baixo.
- **Prioridade:** P2.
- **Critério de conclusão:** duas sessões não interferem; teste cobre.

### R20 — Qualidade e CI
- **Problema:** sem lint/CI; ~60 scripts `test:*` sem runner; lacunas (`adminList*`, `captureFromUserText`); testes de rede misturados.
- **Evidência:** `package.json:6-60`; relatório de testes.
- **Solução:** runner único com separação offline/online, CI local (hook/Tarefa) executando a suíte offline; testes novos para política, aprovações e backup.
- **Dependências:** nenhuma.
- **Risco técnico:** Baixo.
- **Prioridade:** P1.
- **Critério de conclusão:** `npm test` executa toda a suíte offline com um resultado único; falha bloqueia mudanças de política.

## 7. Auditoria de infraestrutura (PC como núcleo)

Viável e coerente com o que existe: Core, memória, Gateway e scheduler já rodam no PC; acesso remoto previsto via Tailscale sem exposição de portas. Lacunas: auto-start, watchdog, verificação do `tailscale serve`, backup, TLS depende do `tailscale serve`, processo único (R08). Não há proposta de abrir portas à internet; `funnel` permanece proibido. Agentes locais (Código/automação) ficam no mesmo host, atrás da política (R01).

## 8. Análise comparativa mínima (restrição: não trocar a IA sem análise)

Nenhuma troca de infraestrutura de IA é recomendada agora. O AI Manager plugável (`legacy-chain`, `gateway`, `openai-compatible`) já permite incluir IA local (LM Studio) sem substituir nada. A única consolidação proposta (R10) **reduz** duplicação reaproveitando o Gateway existente. Qualquer troca de motor de banco (R06) exige comparação própria antes.

## 9. Limites desta auditoria

Somente leitura; apenas 2 suítes executadas; `.env`, `secrets/` e `Yui.pem` não lidos; nada observado em execução real; projeto Electron externo não auditado; afirmações da documentação não reconfirmadas. Veja `GAPS_E_DEBITOS_TECNICOS.md` §6.
