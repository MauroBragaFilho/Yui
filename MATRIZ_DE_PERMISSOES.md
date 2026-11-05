# MATRIZ_DE_PERMISSOES — Autonomia configurável da Yui (proposta)

Proposta de design. Nada foi implementado. Preserva o que já existe: papéis (`permissions.js`), modo somente leitura (`YUI_READ_ONLY`), aprovação local do módulo Código, allowlists de ferramentas e deny por padrão.

## 1. Os quatro estados

| Estado | Significado | Quem decide | Fricção | Registro |
|---|---|---|---|---|
| **AUTOMATICO** | Executa sem perguntar | Política (backend) | Nenhuma | Evento resumido |
| **AUTORIZADO** | Executa após uma aprovação simples do dono, por ação (ou por concessão com prazo/escopo) | Dono em qualquer dispositivo autenticado | 1 toque; expira em 2 min | Comando/alvo completos + aprovador + dispositivo |
| **APROVACAO_CRITICA** | Executa só com aprovação reforçada | Dono **no PC físico** (UI nativa do Desktop ou pedido local), segunda confirmação (ex.: digitar a ação ou PIN) | Alta; expira em 60–120 s; uma vez | Tudo acima + hash do plano/diff + resultado |
| **BLOQUEADO** | Nunca executa, para qualquer papel, mesmo o dono | Política fixa; só muda editando o `.env`/arquivo de política no PC | — | Tentativa registrada |

Mapeamento do que existe hoje: `allow` → AUTOMATICO; `ask` → AUTORIZADO; (inexistente) → APROVACAO_CRITICA; `deny` → BLOQUEADO. `policy.check()` passa a devolver os quatro estados e mantém `allow/ask/deny` como alias para compatibilidade.

## 2. Fluxo de verificação (único ponto de decisão)

```
pedido (interface, userId, canal, dispositivo)
  1. buildContext()            papel, tipo de canal, escopo (backend; nunca o LLM)
  2. normalizar ação           ferramenta, alvo canônico (realpath), argumentos validados
  3. classificar risco         classe da ação (tabela §3) + modificadores (alvo sensível, fora de projeto, remoto)
  4. decidir estado            política = max(classe, modificadores, modo global)  → AUTO | AUTORIZADO | CRITICA | BLOQUEADO
  5. se exigir aprovação       cria Approval{id, plano canônico, hash, expira, usuário, dispositivo}
  6. na execução               revalida papel + hash do plano + validade; consome a aprovação (uso único)
  7. audita                    decisão, aprovador, comando exato, resultado
```

Regras invioláveis:
- **Rebaixamento só pelo dono, no PC** (nunca por painel remoto, LLM ou Discord): mudar o estado de uma classe para algo menos restritivo exige pedido local.
- **Escalar é livre, afrouxar é restrito:** qualquer interface pode tornar uma classe mais restrita.
- **Aprovação vale para um plano exato** (hash do comando/diff/caminhos). Mudou, perde a validade.
- **Resultado de ferramenta, web ou arquivo nunca é instrução** (mantido de hoje).
- **Origem remota nunca aprova nível crítico.** A prova de "local" deixa de depender da ausência de cabeçalhos (ver R02): usar canal de aprovação autenticado separado (dispositivo/UI nativa do Desktop).
- Modo global `YUI_READ_ONLY` continua a ser o piso: rebaixa tudo que escreve/executa para BLOQUEADO enquanto ligado.

## 3. Matriz ação × papel × estado (padrões propostos)

Origem: **PC** = pedido local no computador; **Remoto** = app via Tailscale; **Discord** = DM/canal privado do dono. Demais papéis (TRUSTED, MEMBER, GUEST) só têm acesso a Discord público e memória temporária; BLOQUEADO para tudo que for ferramenta do PC (decisão atual, preservada).

| Classe de ação | Exemplos (existentes ou previstos) | Dono – PC | Dono – Remoto | Dono – Discord privado | Outros papéis |
|---|---|---|---|---|---|
| Leitura de informação | `system.info`, `commands.list`, listar/ler arquivos de projeto da allowlist, `search_code` | AUTOMATICO | AUTOMATICO | AUTOMATICO | BLOQUEADO |
| Busca por nome em pastas autorizadas | `files.search` | AUTOMATICO | AUTOMATICO | AUTOMATICO | BLOQUEADO |
| Memória pessoal: ler/gravar | `remember`, `recall` | AUTOMATICO | AUTOMATICO | AUTOMATICO | memória temporária própria (30 dias) |
| Memória: apagar tudo / exportar | `forgetAll`, backup | AUTORIZADO | AUTORIZADO | AUTORIZADO | só a própria memória, AUTORIZADO pelo próprio usuário |
| Abrir projeto/pasta no editor | `projects.open` | AUTOMATICO | AUTORIZADO | AUTORIZADO | BLOQUEADO |
| Pesquisa na web | `search_web` | AUTOMATICO (limites atuais) | AUTOMATICO | conforme `YUI_PRIVATE_SEARCH` | conforme `YUI_PRIVATE_SEARCH` |
| Gravar/editar arquivo em projeto | `write_file`, `apply_diff` | AUTORIZADO (AUTOMATICO só em modo `auto` por projeto, com backup) | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Comando de terminal da allowlist "segura" (sem shell) | `git status`, `npm test` | AUTOMATICO | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Comando de terminal genérico | qualquer outro | AUTORIZADO | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Comando cadastrado / abrir aplicativo | `commands.run`, `apps.open` | AUTORIZADO | AUTORIZADO* | AUTORIZADO* | BLOQUEADO |
| Instalar/atualizar software, alterar sistema, serviços, rede, registro | — | APROVACAO_CRITICA | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Apagar/mover arquivos em lote, formatar, limpar disco | — | APROVACAO_CRITICA | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Git: commit local | — | AUTORIZADO | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Git: push, force, reset duro, apagar branch | — | APROVACAO_CRITICA | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Enviar mensagem/e-mail em nome do dono; publicar | — | APROVACAO_CRITICA | APROVACAO_CRITICA (confirmação reforçada no PC) | BLOQUEADO | BLOQUEADO |
| Mover dinheiro / compras | — | BLOQUEADO | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Ler `.env`, chaves, certificados, `~/.ssh`, cookies | — | BLOQUEADO | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Alterar a própria política, `YUI_READ_ONLY`, senha, tokens | — | APROVACAO_CRITICA (somente PC) | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Ferramentas MCP externas | por servidor | Estado por ferramenta, padrão APROVACAO_CRITICA até auditar o servidor | BLOQUEADO | BLOQUEADO | BLOQUEADO |
| Administração Discord (bans, AutoMod, canais) | painel Admin | AUTORIZADO | AUTORIZADO | AUTORIZADO | permissões Discord já existentes |
| Reiniciar a Yui | `admin.restart` | AUTORIZADO | AUTORIZADO | — | BLOQUEADO |

\* Hoje exigem `confirm:true` e `YUI_READ_ONLY=false`; mantidos assim até a migração.

**Modificadores que elevam o estado** (um nível por modificador, até BLOQUEADO quando indicado): alvo fora da pasta do projeto; arquivo sensível por conteúdo (não só por nome); comando com `shell`/encadeamento/redirecionamento; origem remota; ação irreversível (sem backup possível); primeira execução de uma ferramenta nova.

**Concessões temporárias** (futuro, opcional): o dono pode conceder "AUTOMATICO por 30 min neste projeto para `npm test`". Sempre com escopo, prazo e revogação; criadas somente no PC; nunca para classes críticas.

## 4. Registro de aprovações

Cada decisão gera um evento de auditoria (JSONL com **hash encadeado**, ver R04):

```
{ ts, seq, prev_hash, hash,
  event: "policy.decision" | "approval.requested" | "approval.granted" | "approval.denied" | "approval.expired" | "action.executed" | "action.failed",
  user, role, interface, device_id, channel_kind, origin: "pc|remote|discord",
  action_class, state, modifiers[],
  plan: { tool, argv|diff_hash|paths[], cwd }, plan_hash,
  approval_id, approver, approved_at, expires_at,
  result: { ok, exit_code, bytes_changed, backup_ref } }
```

- **Nunca** registrar: conteúdo de memória, senhas, tokens, valores de segredos.
- Registrar o plano completo (comando/caminhos), não só a ação.
- Verificação periódica da cadeia; falha de gravação gera alerta ao dono (hoje `audit()` engole o erro).
- Rotação e retenção definidas; arquivo fora do git e com permissão restrita.

## 5. Isolamento de usuários e sessões

- Sessão carrega `user`, `role`, `device_id` e `origin`; aprovações pertencem à sessão que as pediu **e** só podem ser concedidas por quem tem autoridade (dono, PC).
- `runs` do módulo Código indexados por sessão (hoje `activeRun` global).
- Tokens fixos passam a ter expiração e revogação; token do app em armazenamento seguro do SO.

## 6. Critérios de aceite da matriz

1. Existe **um** módulo de política consultado por Discord, API, Agent e Código.
2. Teste automatizado prova, para cada linha da tabela, o estado esperado por papel/origem.
3. Teste prova que aprovação remota é rejeitada em APROVACAO_CRITICA, mesmo simulando proxy sem cabeçalhos.
4. Teste prova que aprovação não vale para plano alterado, nem depois de expirada, nem duas vezes.
5. Auditoria contém comando exato e aprovador; corromper uma linha é detectado.
6. Nenhum caminho de código executa ferramenta sem passar pela política (vigia estilo `tests/test-readonly.js`).
