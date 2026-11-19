---
# MODELO COMENTADO DE SKILL (padrão aberto: https://agentskills.io/specification).
# Para criar uma skill: copie esta pasta, troque o nome da pasta e o `name` (os dois iguais) e edite o texto.
# Só `name` e `description` são obrigatórios. Qualquer campo que não esteja nesta lista faz a Yui recusar a skill.
name: exemplo-modelo   # igual ao nome da pasta; 1 a 64 caracteres; só minúsculas, números e hífens; sem hífen no começo, no fim nem repetido
description: Modelo comentado para criar uma skill nova. Use quando pedirem um exemplo ou modelo de skill, ou ajuda para escrever uma.   # 1 a 1024 caracteres: diz o que a skill faz e QUANDO usá-la (a Yui escolhe a skill por esta frase)
compatibility: Só texto, sem ferramentas.   # opcional, de 1 a 500 caracteres
metadata:   # opcional: pares de texto para texto (um nível só)
  author: yui
  version: "1.0"
# license: MIT        # opcional
# allowed-tools: Read # experimental no padrão; a Yui IGNORA este campo: nenhuma skill ganha ferramenta
---

<!-- Tudo o que está depois do segundo "---" é o corpo: as instruções em Markdown. Estes comentários HTML nunca chegam ao modelo. -->
<!-- Mantenha o corpo com menos de 500 linhas (cerca de 5000 tokens). O corpo só é lido quando a skill é usada. -->
<!-- Material de apoio vai em references/<arquivo>.md e é citado no corpo com o caminho relativo (um nível, sem ".."). Só entra se o arquivo existir. -->
<!-- A pasta scripts/ e o campo allowed-tools são IGNORADOS: a Yui nunca executa nada de uma skill. -->

# Como escrever uma skill

Mostre ao dono este modelo e explique, em poucas linhas, para que serve cada parte:

1. **A pasta**: `skills/<nome>/SKILL.md` (as que vêm com a Yui) ou `secrets/skills/<nome>/SKILL.md` (as que o dono instala à mão).
2. **O cabeçalho**: `name` e `description`. A descrição diz o que a skill faz e quando usar; é por ela que a Yui escolhe a skill.
3. **O corpo**: as instruções, curtas e diretas, em passos numerados.
4. **O que a Yui não faz**: não executa scripts, não instala nada da internet e só usa skills nas conversas do dono.

Se o dono pedir, escreva uma skill nova inteira (cabeçalho e corpo) pronta para ele salvar.
