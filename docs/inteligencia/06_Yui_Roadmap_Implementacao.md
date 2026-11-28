# 06. Yui: roadmap de implementação

**Versão:** 0.1, rascunho.

**Regras do roadmap:**
- Cada fase só começa com o OK do dono.
- Cada fase só termina com os critérios cumpridos e as evidências.
- Nada é publicado durante uma live.

## Fase A: base (estabilidade e backup)

- Publicar os itens prontos da worktree `painel`: backup de lembretes e listas, histórico de 7 dias, corte C2PA.
- Corrigir o atualizador (o `npm notice` no stderr).
- Backup também no Neon (destino 2, só cifrado), mais `tarefas`/`planos` no pacote, mais um ensaio de restauração.
- Conferir o modo da política em produção.
- Decidir sobre Windows Update ou ESU e sobre o SMB.
- Colocar no CI os testes que estão fora dele.

**Conclusão:** restauração ensaiada e documentada, CI completo verde, deploy sem erro.

## Fase B: interpretador em observação

- Perfil `interpretar` no AI Manager.
- `src/core/inteligencia/interpretador.js` com esquema JSON.
- Bateria de cerca de 300 frases.
- Log de comparação com as pré-rotas.
- Circuit breaker de provedor.

**Conclusão:** métricas do doc 05 §2 por 2 semanas. **Nenhuma ação executada pelo interpretador.**

## Fase C: ativação das leituras e do assunto em curso

- O interpretador passa a decidir as consultas de leitura (classe 1): agenda, tarefas, lembretes, listas, memória.
- Assunto em curso (RF-10).
- Política `enforce` para a classe 1.
- Pré-rotas mantidas como reserva.

**Conclusão:** os exemplos das diretrizes passam ("calendário", "e na quinta?", "tem horário livre?").

## Fase D: classe 2 e confirmações vinculadas

- Lembretes, listas e notas via interpretador.
- Pergunta de dado faltante.
- Desfazer.
- Confirmação vinculada (classes 3 e 4).
- `enforce` até a classe 4.

## Fase E: orquestrador de tarefas e autonomia contínua

- `tarefas.db` (SQLite nativo).
- Estados e retomada.
- Prioridade.
- Limites de recursos.
- Execução em segundo plano das classes 1 e 2.
- Pedido de decisão para as classes ≥ 3.
- Os planos atuais migram para cá.

## Fase F: memória estendida e aprendizado

- Colunas novas, conflitos, hipóteses propostas, procedimentos.
- Notificações agrupadas.

## Fase G: desenvolvimento isolado e autoaperfeiçoamento

- Área isolada (doc 02 §9).
- Propostas com diff, testes e reversão.
- Classes 6 e 7 sempre com aprovação.

## Fase H: clientes com cache offline

Android e desktop: fila offline e sincronização. Segue as prioridades Painel → Desktop → Mobile já definidas.

## Dependências

`A → B → C → D → E → F`. G depende de E. H depende de D e da fase de cada cliente.

O desmonte gradual do `llmHandler` acontece ao longo de C a E, cada passo com o CI verde.
