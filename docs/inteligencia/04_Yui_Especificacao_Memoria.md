# 04. Yui: especificação da memória

**Versão:** 0.1, rascunho. **Base:** spec §6, P8, P10, P23, P24, P26 a P28. Esquema atual em `src/core/memory/schemas.js`.

## 1. Tipos (P26) → armazenamento

| Tipo | Conteúdo | Onde |
|---|---|---|
| Episódica | eventos, tentativas, resultados | `memories.type='episode'` + `tarefas.db` (evidências) |
| Semântica | fatos e referências validados | `type='fact'` |
| Procedural | procedimentos e rotinas aprendidos | `type='procedure'` (novo) |
| Preferências | escolhas explícitas | `type='preference'` |
| Decisões | decisões com data e autor | `type='decision'` |
| Projetos | objetivos e estado | `type='project'` + `tarefas.db` |
| Estado operacional | tarefas ativas, assunto em curso | `tarefas.db` + RAM do cérebro |

## 2. Esquema (migração **aditiva**, sem apagar colunas)

**Colunas novas em `memories`:**
- `classe`: fato, hipótese, preferência ou inferência (P23).
- `confianca`: 0 a 1.
- `origem`: dono_disse, observado, ferramenta, web ou inferido.
- `evidencia`: referência.
- `projeto`, `assunto`.
- `validado_em`.
- `substitui_id`: histórico.
- `sensibilidade`: normal, pessoal ou sensível.
- `estado`: ativo, contestado ou arquivado.

**Tabela nova `memory_conflitos`:** `(id, memoria_a, memoria_b, detectado_em, resolucao, resolvido_por)`.

## 3. Quando vira memória duradoura (P27)

| Situação | Grava? |
|---|---|
| O dono pede "lembra que..." | grava como `preferência` ou `fato`, `origem=dono_disse`, confiança 1 |
| A Yui infere algo recorrente (≥ 3 vezes) | grava como `hipótese` e **propõe** ao dono; só vira fato com o "sim" dele (reaproveita `continuidade.js`) |
| Dado sensível (saúde, finanças, credenciais) | não grava sem pedido explícito; credenciais **nunca** |
| Resultado de ferramenta ou web | só como `episódio` ligado à tarefa; não vira fato sozinho |

## 4. Conflitos (P24)

**Precedência** (da mais forte para a mais fraca):
1. o dono disse explicitamente;
2. sistema verificado (ferramenta oficial);
3. observação repetida;
4. web;
5. inferência.

**Resolução automática** só quando a fonte nova tem precedência **maior** e o assunto não é decisão nem preferência. Exemplo: horário de evento lido da agenda corrige uma inferência antiga.

**Nos demais casos:**
- os dois itens ficam `contestado`;
- o conflito é registrado;
- a pergunta vai para o próximo resumo (ou é imediata se bloquear uma tarefa).

**Sempre:** nunca substitui informação confiável só porque a outra é mais recente. A versão antiga é preservada via `substitui_id`.

## 5. Retenção (P27, regras aprovadas)

| Dado | Retenção |
|---|---|
| Memória do dono | permanente; apagar só por pedido dele (classe 5) |
| Memória de terceiros no Discord | 30 dias após a última interação (já implementado) |
| Contexto por horas | conforme a configuração atual |
| `historico.txt` | 7 dias (correção pronta na worktree `painel`) + incluído no "apagar tudo" |
| Evidências de tarefa | 90 dias após a conclusão **[proposta]** |
| Auditoria | regras atuais (2 meses na live) |

Toda expiração é **verificável**: o teste cria um registro datado no passado, roda a limpeza e confere que ele sumiu.

## 6. Acesso

Filtro obrigatório por `user_id` e audiência, na camada de memória e não na IA. O dono pode ver, corrigir e apagar a própria memória pelo painel.

## 7. Sincronização e offline (P10, P28; proposta C4)

- **Fonte única:** os bancos do cérebro no ASUS.
- **Clientes (Android e desktop):**
  - cache cifrado com o assunto em curso, as tarefas abertas e os últimos 50 itens relevantes;
  - fila local de ações (classes 1 e 2) com `id` idempotente.
- **Ao reconectar:**
  - envia a fila;
  - o servidor aplica na ordem, recusa o que conflita e devolve a lista do que **não** foi aplicado. O cliente mostra isso.
- **Ponto de partida:** a idempotência já existe no canal (`idem`).

## 8. Backup

- O pacote cifrado atual (XChaCha20) **+ tarefas.db + lembretes, listas e planos** é enviado ao GitHub privado **e ao Neon** (destino 2).
- O Neon recebe só arquivos cifrados, sem a chave.
- Há um teste mensal de restauração (`backup-offsite --verify`).
