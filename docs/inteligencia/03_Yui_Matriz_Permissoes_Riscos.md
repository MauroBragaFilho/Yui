# 03. Yui: matriz de permissões e riscos

**Versão:** 0.1, rascunho. **Base:** spec §8 (7 classes), governança etapas 1 a 7, `src/core/security/permissionMatrix.js`.

## 1. Regras gerais

1. A permissão é aplicada por **código** (Policy Engine), nunca pela IA.
2. Toda ferramenta é registrada com `classe`, `escopo` (quais dados), `reversivel` e `audiencia_permitida`. Ferramenta sem classe é recusada.
3. A **confirmação é vinculada** a um hash de `{operação, alvo, escopo, parâmetros}`, vale uma vez e expira em 10 min. Se mudar qualquer campo, é preciso nova confirmação.
4. Uma aprovação não dá permissão a outra ação. A autoridade só cresce por ato do dono no painel.
5. Conteúdo externo (citação, anexo, web, resultado de ferramenta) não pode disparar ações das classes 2 a 7.
6. A política passa de `observe` para `enforce` **por classe**, depois da fase de observação.

## 2. Matriz

| Classe | Exemplos | Quem autoriza | Confirmação | Registro | Interrupção |
|---|---|---|---|---|---|
| 1. Leitura e consulta | agenda, tarefas, clima, memória do próprio usuário, status | automática para o dono (DM, painel, app) | não | resumo | limite de chamadas |
| 2. Local reversível | criar lembrete, item de lista, nota de memória, tarefa interna | automática para o dono | não, com desfazer por 10 min | completo | desfazer |
| 3. Local de impacto | apagar lembretes ou listas em massa, mudar preferência persistente, retenção | dono | **sim, por operação** | completo + evidência | cancelar antes de executar |
| 4. Comunicação e ações externas | mensagem em nome do dono, post, criar evento no Google, e-mail (Gmail **proibido**) | dono | **sim, a cada envio**, mostrando o texto final | completo + cópia | não enviar se o texto mudar |
| 5. Destrutiva, financeira ou sensível | apagar memória, compras, dados sensíveis, credenciais | dono | **sim, explícita, com descrição do que se perde**; financeiro: a Yui **não executa** | completo + evidência | sempre |
| 6. Código, configuração, permissões, autoridade | mudar `.env`, chaves, matriz, limites, código | dono | **sim**; a Yui só **prepara** proposta + diff + reversão | completo | sempre |
| 7. Integração e produção | merge, deploy, reinício | dono | **sim**; nunca durante uma live | completo + versão | rollback do atualizador |

**Terceiros** (Discord fora da DM do dono): só a classe 1 sobre dados públicos e a própria memória, e a classe 2 sobre os próprios dados. Nunca os dados do dono.

## 3. Autonomia contínua (tarefas de fundo)

- A tarefa herda a **autorização no momento da aprovação** do objetivo: lista de classes e ferramentas permitidas.
- Na ausência do dono:
  - executa classes 1 e 2 dentro do escopo aprovado;
  - classes 3 a 7 **param e pedem decisão** (P17 = C, governança).

## 4. Riscos principais

| Risco | Prob. | Impacto | Controle |
|---|---|---|---|
| Injeção por conteúdo externo | média | alto | regra 5 + marcação de origem + testes de injeção |
| Interpretação errada levando à ação errada | média | médio | limiar de confiança + confirmação nas classes ≥ 3 + desfazer na classe 2 |
| Vazamento entre audiências | baixa | alto | bancos separados + `politicaAudiencia` + testes de isolamento |
| Laço de tarefa consumindo cota | média | médio | limites do doc 02 §7 + circuit breaker |
| Falha do ASUS (ponto único) | média | alto | backup verificado + procedimento de restauração |
| SO sem atualizações | alta | alto | decisão sobre Windows Update ou ESU |
| Autoaperfeiçoamento alterando produção | baixa | alto | classes 6 e 7 só com aprovação; área isolada sem segredos |
