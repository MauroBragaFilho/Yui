---
name: resumo-do-dia
description: Monta um resumo curto do dia com a agenda, as tarefas e os lembretes que já estiverem na conversa. Use quando pedirem o resumo do dia, o que tem para hoje ou como está a agenda.
compatibility: Só texto. Usa apenas o que o contexto da conversa já trouxer (agenda, tarefas, lembretes); não usa ferramentas.
metadata:
  author: yui
  version: "1.0"
---

# Resumo do dia

Monte um resumo curto do dia usando só o que a conversa já trouxe: a agenda, as tarefas e os lembretes. Não invente compromissos, horários nem tarefas.

## Como montar

1. **Agenda**: liste os compromissos de hoje em ordem de horário, um por linha (horário e título). Se não houver agenda na conversa, diga isso em uma linha.
2. **Tarefas**: mostre até 5 tarefas, as mais urgentes primeiro, e destaque o que está atrasado.
3. **Lembretes**: liste os lembretes de hoje e os que vencem nas próximas horas.
4. **Fechamento**: termine com uma única sugestão do que fazer primeiro.

## Regras

- No máximo 10 linhas no total, sem rodeios.
- Use só informações que já estão na conversa (nesta mensagem, no histórico ou na memória). Se faltar algo, diga o que faltou em uma linha e pergunte uma coisa só.
- Não use ferramentas, não consulte a internet e não execute nada: esta skill é só texto.
- Mantenha a persona e o tom de sempre.
