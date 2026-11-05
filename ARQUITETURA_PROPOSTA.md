# ARQUITETURA_PROPOSTA — Yui como Assistente Pessoal

Proposta. Nenhuma alteração de código foi feita. Evolui o que existe (`ARQUITETURA_ATUAL.md`); não reconstrói. Recomendações referenciadas como R01–R20 estão em `AUDITORIA_TECNICA.md` §6.

## 1. Princípios

1. **Evoluir, não reconstruir:** manter Core, Gateway, API, app, Discord e engines GTA.
2. **PC como núcleo**, acesso remoto só pela tailnet; nenhuma porta pública.
3. **Uma política, um Core, um pipeline** para todas as interfaces.
4. **Autonomia configurável** com quatro estados e aprovação crítica no PC físico (`MATRIZ_DE_PERMISSOES.md`).
5. **Memória do dono permanente; dos demais, temporária** (inalterado).
6. **Módulos lógicos, não projetos novos:** os nove nomes viram diretórios/fronteiras dentro de `src/core` e `apps/`, salvo justificativa técnica (§3).

## 2. Visão alvo

```
Interfaces (clientes finos)
  Discord adapter │ App Android/Web │ Desktop (janela + aprovações nativas) │ Voz
        └────────────┴──────────────┬──────────────┴───────────────┘
                                     ▼   Yui Connect (API + canal de aprovação, loopback/tailnet)
 ┌────────────────────────────── YUI CORE (um processo lógico, módulos) ────────────────────────────┐
 │ security/policy  ← única decisão: papel, canal, origem, classe da ação → 4 estados              │
 │ security/audit   ← JSONL com hash encadeado                                                        │
 │ intelligence     ← AI Manager + Gateway (única cadeia de provedores) + persona + pesquisa         │
 │ memory           ← pessoal (permanente) │ discord (30 d) │ contexto │ entidades │ backup          │
 │ agent/tools      ← ferramentas classificadas; Agent usado por TODAS as interfaces                  │
 │ automation       ← tarefas agendadas e planos, sempre via policy; MCP (stdio)                     │
 │ dev (Código)     ← projetos, arquivos, terminal sem shell, runs por sessão                         │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
 Supervisão (PC): Tarefa Agendada/NSSM + watchdog(/v1/health) + verificação do tailscale serve + backup
```

## 3. Módulos conceituais: necessidade e decisão

| Módulo | O que já cobre | Necessidade | Decisão técnica |
|---|---|---|---|
| **Yui Core** | `src/core` | Núcleo independente das interfaces | Manter; remover dependência de `handlers/` e do `legacy-chain` (R10) |
| **Yui Intelligence** | `ai/manager`, `gateway`, `persona`, pesquisa | Uma cadeia de provedores, IA local pluggable | Pasta/fronteira em `src/core/ai`; **sem projeto separado**. Gateway já é processo opcional |
| **Yui Memory** | `core/memory`, `core/context` | Entidades, busca, backup, retenção | Fronteira em `src/core/memory`; sem serviço separado |
| **Yui Automation** | parte de `agent/tools`, scheduler | Tarefas do dono sob política | Novo diretório `src/core/automation`; reutiliza `node-cron` |
| **Yui Security** | `permissions.js`, `audit.js`, `dev/policy.js` | Política única + auditoria encadeada | Novo `src/core/security` consolidando os existentes (R01, R04) |
| **Yui Desktop** | Electron fora do repo | Aprovação nativa, bandeja, auto-start | **Único candidato a projeto próprio** (`apps/desktop`), porque exige UI nativa/processo separado do Core — justifica-se tecnicamente; decidir com o dono (R13) |
| **Yui Manager** | aba Admin do app, painel | Já existe | Não criar projeto; evoluir a aba Admin (política, auditoria, backups) |
| **Yui Voice** | `services/tts`, `sttService` | Validar em call; depois no app/Desktop | Manter em `src/services`; sem projeto separado |
| **Yui Connect** | `core/api`, Gateway, Tailscale | API, canal de aprovação, estabilidade remota | Manter em `core/api`; adicionar canal de aprovação (R02) e supervisão (R08) |

## 4. Memória (arquitetura proposta)

- **Mantém** os bancos `memory-personal` (permanente) e `memory-discord` (30 dias deslizantes) e o escopo decidido por `buildContext`.
- **Acrescenta**, no mesmo motor e com migração reversível:
  - `entities` (pessoa, projeto) e `links` (entidade ↔ memória/decisão);
  - `episodes`: resumos periódicos do contexto por horas (memória episódica), gerados sob demanda e marcados como origem `summary`;
  - busca com normalização e índice (e embeddings opcionais quando existir IA local — `AI_PRIVATE_LOCAL_ONLY` garante que contexto pessoal só vá a modelo local);
  - retenção explícita de `historico.txt` e limpeza ao banir/sair de servidor (funções já existem, falta chamar).
- **Backup:** rotativo, cifrado, verificado por hash, com restauração testada (R05). Chave fora do repo.
- **Contexto entre interfaces:** chave de conversa por pessoa (`userId` canônico) além de por canal, apenas para o dono, preservando o isolamento dos demais.

## 5. Segurança e autonomia

Resumo (completo em `MATRIZ_DE_PERMISSOES.md`):
- Decisão central `policy.decide(ctx, action) → AUTOMATICO | AUTORIZADO | APROVACAO_CRITICA | BLOQUEADO`.
- Aprovações são objetos (`Approval`) presos ao hash do plano, de uso único e com expiração.
- **Canal de aprovação** separado: nível crítico só pela UI nativa no PC (R02, R13); remoto nunca aprova crítico.
- Terminal sem shell, plano exato (R03). Auditoria encadeada (R04).
- Piso `YUI_READ_ONLY` preservado; política só afrouxa pelo dono no PC.

## 6. Infraestrutura

- **Núcleo no PC (Windows):** Core + Gateway + scheduler no mesmo processo hoje; **supervisor** externo (Tarefa Agendada/NSSM) reinicia e alerta. Separar o Gateway em processo próprio é opcional e só se a medição mostrar necessidade (I3).
- **Rede:** API em `127.0.0.1`; `tailscale serve` (HTTPS na tailnet) verificado a cada subida; `funnel` proibido; ACLs do Tailscale restringindo dispositivos do dono. Nenhuma porta aberta à internet.
- **Disponibilidade:** auto-start no boot; `/v1/health` mínimo público e detalhado autenticado; reinício automático; alerta por DM; rotação de logs; política de energia (sem hibernar).
- **Recuperação:** backup de memória e configuração; procedimento de restauração testado; `database/*.db` de runtime fora do git, recriáveis a partir de sementes.
- **Modo degradado:** PC desligado = Yui offline (decisão já aceita). Documentar o RTO esperado.

## 7. Estratégia de migração (sem parar a Yui pública)

1. Fundação segura (backup, auditoria, higiene, supervisão) — sem mudar comportamento.
2. Motor de política atrás de adaptador, mantendo `allow/ask/deny`; migrar chamadores um a um.
3. Canal de aprovação e Desktop.
4. Unificação do pipeline (R10) atrás de flag; manter `legacy-chain` até paridade comprovada pelas suítes atuais.
5. Memória v2 e automação por último, sobre base já auditável.

Toda etapa preserva funcionalidades existentes, mantém suítes verdes e tem reversão.
