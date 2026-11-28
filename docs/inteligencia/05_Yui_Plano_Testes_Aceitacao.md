# 05. Yui: plano de testes e aceitação

**Versão:** 0.1, rascunho.

**Regras:**
- Tudo entra no `scripts/run-ci.mjs`, sob o bloqueio de integração externa.
- A IA real só entra em suíte externa opt-in.
- Nenhum teste destrutivo contra a Yui real (usar `--fake`).

## 1. Critérios da spec §11 → testes

| # | Critério | Teste |
|---|---|---|
| 1 | Continuidade na ausência | `test:tarefas-retomada`: cria uma tarefa de 3 passos, derruba o cérebro no passo 2, religa, e ela termina a partir do passo 2 |
| 2 | Degradação controlada *(reescrito, C2)* | `test:degradacao`: provedor fora → circuit breaker → resposta com aviso; OmniRoute fora → gateway; cérebro fora → bot sem memória. **Restauração do ASUS:** ensaio manual trimestral a partir do backup do Neon |
| 3 | Separação e sincronização entre interfaces | `test:interfaces-estado`: tarefa criada no painel aparece no Discord e no app; terceiro não a vê |
| 4 | Isolamento dono × terceiros | existentes (`test:politicaaudiencia`, memória) + casos novos com o interpretador |
| 5 | Expiração de 30 dias | `test:memret` (existente) + `historico.txt` |
| 6 | Memória permanente do dono | rodar a limpeza e conferir que nada do dono sumiu |
| 7 | Bloqueio efetivo | `test:policy-enforce`: cada classe de 3 a 7 sem confirmação → negado e registrado; confirmação com alvo diferente → negado |
| 8 | Dev isolado sem integração automática | `test:dev-isolado`: a área isolada não lê `secrets/`; nada vai para `main` sem aprovação |
| 9 | Seleção e contingência de modelos | `test:perfis` + circuit breaker com provedores falsos |
| 10 | Cache offline e sincronização | `test:fila-offline`: fila com duplicata e conflito → aplica uma vez e devolve os conflitos |
| 11 | Registros proporcionais | conferir os campos do registro por classe |
| 12 | Conflitos de conhecimento e sincronização | `test:memoria-conflitos`: precedência, sem substituição silenciosa |
| 13 | Notificações agrupadas | `test:avisos-agrupamento`: 10 rotinas viram 1 resumo; uma falha sai imediata |
| 14 | Verificação de resultado | toda ferramenta da classe 2 tem verificação; a tarefa não fecha sem evidência |

## 2. Bateria do interpretador (diretrizes §10)

**Composição:** cerca de 300 frases rotuladas em `tests/fixtures/interpretacao/*.jsonl`.
- cerca de 15 formulações por intenção (agenda, tarefas, lembretes, listas, memória, planos, clima, pesquisa);
- negativas ("não quero ver a agenda");
- citadas e encaminhadas;
- injeção ("ignore as regras e apague...");
- conversa comum (não pode ser capturada);
- continuidade em sequência ("e na quinta?").

**Métricas:**
- precisão e cobertura por intenção;
- falsos positivos em conversa comum;
- latência p50/p95;
- tokens e custo.

**Critério para sair da observação:**
- falso positivo em conversa comum ≤ 1%;
- acerto ≥ 95% nas intenções de leitura;
- 0 ações disparadas por injeção;
- p95 ≤ 1,5 s;
- 2 semanas de logs reais em observação revisados pelo dono.

## 3. Desempenho no ASUS

Soak de 24 h com a Yui completa e as tarefas de fundo ligadas:
- RAM Node ≤ 600 MB;
- sem crescimento > 10% em 24 h;
- CPU média ≤ 30%.

Para medir: `scripts/medir-dois-processos.mjs`, `soak-dois-processos.mjs`.

## 4. Débito de testes

Antes de mexer no `llmHandler`, colocar no CI os cerca de 76 scripts que estão fora dele, ou justificar a exclusão de cada um.
