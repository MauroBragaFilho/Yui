# 01. Yui: especificação funcional da Inteligência

**Versão:** 0.1 (rascunho para revisão do Braga e da Liz). **Data:** 28/11/2026.

**Base:**
- `Yui_Especificacao_da_Inteligencia_Consolidada.md` v2.0
- diretrizes de 28/11
- `docs/Yui_Diagnostico_Tecnico_Atual.md`

**Convenções:**
- Os requisitos têm identificador `RF-xx` e citam a pergunta da spec (P1 a P30).
- Onde houver contradição, vale o §7B do diagnóstico e o doc 07, e o ponto aparece marcado como **[A DECIDIR]**.
- Nada aqui autoriza implementação.

## 1. Capacidades

### 1.1 Compreensão natural (diretrizes §3; P19)
- **RF-01.** A Yui reconhece a intenção por significado, não por palavras-chave. Exemplo: "veja meu calendário hoje", "como está minha agenda", "tenho algo hoje?" e "tô livre hoje?" são todas uma `agenda.consultar(período=hoje)`.
- **RF-02.** Resolve referências ao contexto ("e na quinta?", "tem horário livre?") usando o **assunto em curso** (RF-10).
- **RF-03.** Pergunta somente quando falta um dado obrigatório ou quando a ambiguidade muda o resultado. Exemplo: "me lembra de pagar a conta" leva a "quando?".
- **RF-04.** Se não entendeu, diz que não entendeu. Nunca inventa uma interpretação para agir.
- **RF-05.** Conteúdo citado, encaminhado, anexado ou vindo de ferramenta/web **nunca** vira instrução do dono (diretrizes §7).

### 1.2 Objetivos e tarefas (P1, P3, P16, P17, P20 a P22; spec §9)
- **RF-06.** Um pedido com objetivo ("precisamos terminar o projeto X") vira um **Objetivo** com plano, tarefas, dependências e critérios de aceitação.
- **RF-07.** As tarefas autorizadas continuam sem conversa aberta, inclusive na ausência do dono (P17 = C). Elas retomam depois de uma queda ou reinício.
- **RF-08.** A priorização usa urgência, importância e dependências (P20). A fórmula fica no doc 02, §6.
- **RF-09.** Impedimento leva a diagnóstico, classificação (permissão, dado ausente, serviço fora, erro, limite de recurso), alternativas permitidas e, só se for preciso, pedido de intervenção (P22). Um bloqueio de permissão **nunca** é contornado.

### 1.3 Continuidade de contexto (P10, P14)
- **RF-10.** Cada pessoa tem um **assunto em curso** por interface, com tipo, entidades e validade. Ele expira por tempo ou quando o assunto muda.
- **RF-11.** A mesma identidade aparece em Discord, painel, Android e desktop. Tarefas, decisões e estado são compartilhados conforme as permissões.

### 1.4 Verificação e transparência (P21, P29; diretrizes §3.5)
- **RF-12.** Nenhuma tarefa é dada como "concluída" sem uma evidência que atenda ao critério de aceitação (exemplo: lembrete criado → relido do armazenamento).
- **RF-13.** A resposta distingue verificado, inferido, a confirmar, impossível e não autorizado.
- **RF-14.** O registro é proporcional ao impacto: objetivo, plano, permissões usadas, ações, evidências, resultado, falhas e decisões pendentes (P29).

### 1.5 Memória e aprendizado (P8, P9, P23, P24, P26, P27)
- **RF-15.** A memória é organizada por pessoa, projeto e assunto (P8), com os tipos do doc 04.
- **RF-16.** Cada item guarda origem, evidência, confiança, data e classe (fato, hipótese, preferência ou inferência) (P23).
- **RF-17.** Um conflito relevante nunca é resolvido em silêncio: a Yui compara as fontes e pergunta (P24).
- **RF-18.** Ajustar um procedimento é aprendizado operacional. Mudar código, configuração ou permissão segue a matriz (doc 03) (P9).

### 1.6 Iniciativa e comunicação (P2, P15, P30)
- **RF-19.** A Yui identifica oportunidades e riscos, inclusive fora dos projetos atuais (P2 = C). Ela **propõe**; não executa nada fora da autorização.
- **RF-20.** As notificações são agrupadas em resumo e as exceções (risco, bloqueio, falha, prazo) são destacadas (P30). Respeitam o horário silencioso e o canal preferido.

### 1.7 Autoaperfeiçoamento e desenvolvimento (P12, P25)
- **RF-21.** A Yui pode pesquisar, prototipar e testar melhorias **em área isolada** e entregar evidências, riscos, impacto e plano de reversão. A integração em produção depende de autorização (classe 7).

### 1.8 Modelos e recursos (P6, P7, P18)
- **RF-22.** Os modelos são escolhidos por tarefa (capacidade, qualidade, custo, disponibilidade, privacidade), com contingência entre provedores.
- **RF-23.** A Yui respeita os limites de recursos configurados pelo dono e nunca os amplia sozinha (P18 = B).

### 1.9 Funcionamento degradado e offline (P5, P28)
- **RF-24.** Se um provedor ou serviço cair, a Yui segue com capacidades reduzidas e diz o que está indisponível.
- **RF-25.** Os clientes (Android e desktop) mantêm um cache local de contexto e tarefas, com fila de envio e sincronização posterior **[proposta C4]**.

## 2. Fluxo principal (por mensagem)

```
mensagem → identidade/canal/audiência → INTERPRETAR (intenção + entidades + confiança, sem dados pessoais)
        → POLÍTICA (classe de ação, permissão, exige confirmação?) → [pergunta | confirmação | negar]
        → EXECUTAR (ferramenta com escopo mínimo) → VERIFICAR → RESPONDER (com o estado do conhecimento)
        → REGISTRAR (auditoria proporcional) → atualizar o assunto em curso / tarefa
```

## 3. Estados de uma tarefa

`proposta → aguardando_aprovação → pronta → executando → verificando → concluída`.

Desvios:
- `bloqueada(motivo)`
- `aguardando_dependência`
- `falhou(diagnóstico)`
- `cancelada`
- `pausada(recurso)`

A retomada parte do último passo verificado.

## 4. Interfaces

| Interface | Papel | Restrições |
|---|---|---|
| Discord (DM do dono) | completa | conforme a matriz |
| Discord (servidores e terceiros) | conversa pública | sem dados pessoais do dono; memória de 30 dias |
| Voz | conversa | escopo público, sem ferramentas pessoais (regra atual mantida) |
| Painel | administração e aprovações | autenticado |
| Android / desktop | assistente pessoal | cache offline; permissões do sistema |

## 5. Critérios de aceitação

São os 14 da spec §11, convertidos em testes no doc 05. O critério 2 foi reescrito por causa da contradição C2 (doc 07).
