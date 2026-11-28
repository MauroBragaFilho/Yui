# 02. Yui: arquitetura técnica

**Versão:** 0.1, rascunho. **Princípio:** monólito modular, aproveitando o código existente. Não se cria processo novo sem medição que justifique.

## 1. Restrições medidas (diagnóstico, §1)

- **Máquina:** ASUS X450LD, i7-4500U (2 núcleos e 4 threads), **3,89 GB de RAM**, **HDD**, Windows 10 **Home** 22H2.
- **Orçamento de RAM proposto para a Yui:** no máximo 600 MB somando todos os processos Node. O OmniRoute fica à parte (cerca de 470 MB, onde estiver rodando).
- **Consequências:**
  - toda inferência de IA é **na nuvem**;
  - nada de modelo local nem banco vetorial pesado;
  - classificador = chamada de modelo leve na nuvem.

## 2. Mapa das camadas → código existente

| Camada (diretrizes §9) | Onde vive | Situação |
|---|---|---|
| Intelligence Core (interpretar, contexto, planejar) | `src/cerebro/conversa.js` + **novo** `src/core/inteligencia/` (interpretador, assunto em curso, planejador) | a criar dentro do cérebro |
| AI Manager | `src/core/ai/manager.js`, `perfis.js`, `seletorPerfil.js`, `src/gateway/*` | existe; **reutilizar**, acrescentando o perfil `interpretar` (modelo rápido e barato, JSON) e um circuit breaker |
| Policy Engine | `src/core/security/policyEngine.js`, `permissionMatrix.js`, `approvalManager.js` | existe em `observe`; ganha as 7 classes (doc 03) e passa a `enforce` por classe |
| Execution Layer | `src/core/agent/tools.js`, `src/core/planos/ferramentas.js`, integrações | existe; unificar o registro de ferramentas com classe e escopo |
| Task Orchestrator | **novo** `src/core/tarefas/` (fila persistente, estados, retomada), evoluindo de `core/planos` | a criar |
| Response Generator | `persona.js` + `promptConversa.js` + `limpezaResposta.js` | existe; acrescentar o "estado do conhecimento" (RF-13) |
| Notificações | `core/avisos/fila.js` | existe (`observar`); ganha agrupamento e exceções |

## 3. Processos (sem mudança de topologia)

```
YuiBot (Agendador) → supervisor ─┬─ cérebro  (Core, Policy, Tasks, Memory, AI Manager, Yui API)
                                 └─ bot      (adaptador Discord/voz; sem inteligência própria)
YuiWebApp (painel)   |   clientes Android/desktop → Yui API (HTTPS via Tailscale)
```

- O **orquestrador de tarefas roda dentro do cérebro**, com um tique a cada 60 s e no máximo 1 tarefa executando por vez (configurável pelo dono).
- O `llmHandler` do bot é esvaziado aos poucos: as decisões migram para o cérebro e o bot vira só adaptador (diretrizes §8).

## 4. Fluxo de interpretação

1. **Pré-rota por código** (atual) continua como caminho rápido e reserva.
2. **Interpretador** (perfil `interpretar`):
   - recebe o texto, o assunto em curso (só tipo e entidades) e a lista de capacidades;
   - **não recebe** dados pessoais (agenda, memória);
   - devolve `{intencao, entidades, confianca, faltando[], ambigua}` em JSON validado por esquema.
3. **Regras de decisão:**
   - `confianca ≥ 0,8` e não ambígua: segue para a política;
   - entre 0,5 e 0,8: pergunta objetiva;
   - abaixo de 0,5: conversa normal.
4. **Modo observação** (fase B do roadmap): o interpretador roda ao lado da pré-rota e só registra a comparação em `logs/interpretacao.jsonl`.
5. **Custo e latência:** a meta é p95 ≤ 1,5 s e no máximo 1 chamada extra por mensagem pessoal. Mensagens públicas e de voz não passam pelo interpretador na fase inicial.

## 5. Armazenamento

- **Bancos novos em `node:sqlite` com WAL** (`YUI_DB_NATIVE`). O `sql.js` reescreve o arquivo inteiro a cada escrita, o que é ruim no HDD.
  - `tarefas.db`: objetivos, tarefas, passos, dependências, evidências.
  - Memória estendida: doc 04, migração aditiva nos `memory-*`.
- Os JSONs de estado (`lembretes`, `listas`, `planos`) migram para SQLite numa fase posterior, com backup e reversão.

## 6. Priorização (P20, mensurável)

```
prioridade = 3·urgência + 2·importância + 1·desbloqueia_outros − penalidade_recurso
urgência: 0 a 3 conforme o prazo (sem prazo 0; >7 d 1; ≤7 d 2; ≤24 h 3)
importância: 0 a 3 (dada pelo dono ou herdada do objetivo; padrão 1)
desbloqueia_outros: nº de tarefas dependentes (máx. 3)
penalidade_recurso: 2 se a RAM livre < 400 MB ou a cota de API do dia > 80%
```

Uma tarefa com dependência pendente não entra na fila. Os empates vão pela ordem de chegada.

## 7. Recursos (P18; limites do dono, valores propostos)

| Recurso | Limite proposto | Ação ao atingir |
|---|---|---|
| RAM livre do sistema | < 400 MB | pausa tarefas de fundo; conversa continua |
| CPU média em 5 min | > 85% | adia tarefas de fundo |
| Disco livre | < 10 GB | para logs de depuração e avisa |
| Chamadas de IA de fundo | 200/dia | pausa as tarefas de fundo até o dia seguinte |
| Custo de nuvem | R$ 0 (só camadas gratuitas) | nunca liga provedor pago sozinha |

Todos ficam em `painel-config`, alteráveis **só pelo dono**.

## 8. Contingência

- **Provedor de IA:** circuit breaker por provedor (3 falhas ou timeout de 20 s → aberto por 5 min) e o próximo provedor do perfil. O perfil `privado` continua falhando fechado.
- **Queda do OmniRoute:** o gateway próprio assume os perfis não privados.
- **Queda do cérebro:** o bot responde que está com capacidade reduzida (comportamento atual).
- **Queda do ASUS:** a Yui fica fora do ar. A recuperação é pelo backup (doc 06, fase A), com meta de restauração em até 4 h **[a confirmar]**.
- **Neon:** só backup, então a queda dele não afeta a operação **[C1/C2]**.

## 9. Desenvolvimento isolado (P12, P25)

- **Restrição:** o Windows Home não tem Sandbox nem Hyper-V.
- **Proposta:**
  - área isolada = **worktree git + conta de usuário Windows sem privilégios + rede só para provedores de IA**, executada fora do horário de pico;
  - nenhum acesso a `C:\Yui\secrets`, `.env` nem aos bancos de produção (usa cópias anonimizadas);
  - o resultado é entregue como branch e relatório. O merge e o deploy são da classe 7.
- **Alternativa:** fazer isso no Neon, que é mais forte, **se** o dono permitir esse uso (hoje o Neon é só backup) **[A DECIDIR]**.

## 10. Segurança operacional do host

- Reativar o Windows Update ou decidir pelo ESU **[A DECIDIR]**.
- Fechar SMB 139/445 se não for usado pelo BDS.
- Manter os segredos com ACL SYSTEM + Administradores.
