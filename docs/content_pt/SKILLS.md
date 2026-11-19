# 🧩 Skills no padrão aberto

Uma **skill** é uma pasta com um arquivo `SKILL.md`: instruções em texto que a Yui segue quando o pedido do dono combina com a skill (um "resumo do dia", um plano de treino, um jeito de revisar um texto). A Yui lê as skills no **padrão aberto** [agentskills.io](https://agentskills.io/specification), o mesmo formato que outras ferramentas de IA usam.

Vem **desligado**: sem `YUI_SKILLS=true` nada disto roda e a Yui se comporta como sempre. Vale na conversa do Discord quando a Yui roda com o **cérebro separado** (`YUI_CEREBRO_EXTERNO=true`, dois processos): é o cérebro que monta o prompt e carrega as skills. Com o processo único, e no chat do app (que usa o Agent), a chave não tem efeito.

> Existe também uma leitura mais simples de skills para o Agent do app, descrita em [Comandos e skills](COMANDOS_E_SKILLS.md#-3-skills). Esta página é sobre o carregador do padrão aberto, usado na conversa do cérebro. Uma skill que traz o campo `metadata` é lida só por este carregador.

---

## 🔒 1. O que a Yui faz e o que ela NÃO faz

| A Yui faz | A Yui **não** faz |
|-----------|-------------------|
| Lê as pastas de skills **do próprio computador**, só leitura | **Não executa nada** de uma skill: a pasta `scripts/` e o campo `allowed-tools` são **ignorados** (e registrados como ignorados no log) |
| Valida cada skill pela especificação; a que está errada **não carrega** e aparece com o motivo | **Não baixa** skill da internet e **não instala** sozinha: quem instala é o dono, à mão |
| Escolhe **no máximo uma** skill por mensagem, por palavras, **sem chamar IA** para escolher | **Não dá ferramentas** à skill: a resposta que usa uma skill é só texto, sem ferramentas |
| Põe o texto da skill escolhida no prompt, num bloco rotulado ("instruções da skill X, instalada pelo dono") | **Não usa skill** para membro, convidado, canal público, voz, conversa espontânea nem texto de terceiros |
| Responde "quais skills você tem?" **por código**, sem IA | **Não lê** arquivo fora da pasta da skill e **não segue** link simbólico nem junção |
| Registra na auditoria uma linha `skill.usada` (só o nome da skill) | **Não grava** a conversa nem o texto da skill no log nem na auditoria |

Uma skill orienta o **formato e o conteúdo** da resposta. Ela não muda as regras de segurança nem a persona, não concede permissão e não consegue pedir uma ação: o que a Yui pode fazer continua decidido pelo código.

---

## ⚙️ 2. Como ligar

```env
YUI_SKILLS=true
# opcional: só estas skills valem (vazio = todas as válidas)
YUI_SKILLS_PERMITIDAS=resumo-do-dia,plano-de-treino
# opcional: pastas extras de skills (separadas por |)
YUI_SKILLS_PASTAS=D:/minhas-skills|D:/outras-skills
```

| Variável | Padrão | O que faz |
|----------|--------|-----------|
| `YUI_SKILLS` | `false` | Liga as skills no padrão aberto na conversa do cérebro |
| `YUI_SKILLS_PERMITIDAS` | vazio | Nomes liberados (vírgula, espaço, `;` ou `\|`). Vazio = todas as válidas |
| `YUI_SKILLS_PASTAS` | vazio | Pastas extras, além de `skills/` e `secrets/skills/` (caminho absoluto ou relativo à raiz da Yui) |

Mudou o `.env`? Reinicie a Yui. Mudou uma skill? Não precisa reiniciar: as pastas são lidas a cada uso, e a skill é validada de novo na hora em que é usada.

---

## 📁 3. Onde ficam as skills

| Pasta | O que é |
|-------|---------|
| `skills/` (na raiz da Yui) | As que vêm com a Yui: `resumo-do-dia` e `exemplo-modelo` (um modelo comentado para copiar) |
| `secrets/skills/` | As que **o dono instala à mão**. A pasta `secrets/` é ignorada pelo Git: nada daqui vai para o repositório |
| as de `YUI_SKILLS_PASTAS` | Pastas extras, na ordem em que foram escritas |

Se o mesmo nome existir em duas pastas, vale a primeira (a da Yui, depois a do dono, depois as extras) e a outra aparece como `nome_duplicado`.

---

## ✍️ 4. Como criar uma skill

```
secrets/skills/
└── resumo-da-semana/
    ├── SKILL.md          (obrigatório)
    ├── references/       (opcional: textos de apoio, em .md)
    ├── scripts/          (ignorada: nunca é lida nem executada)
    └── assets/           (ignorada)
```

```markdown
---
name: resumo-da-semana
description: Monta um resumo curto da semana com compromissos e pendências. Use quando pedirem o resumo da semana ou o que vem pela frente.
---

# Resumo da semana

1. Liste os compromissos dos próximos 7 dias, um por linha.
2. Destaque o que está atrasado.
3. Termine com uma sugestão do que fazer primeiro.

Se precisar de um guia de formato, veja references/formato.md.
```

O cabeçalho (entre `---`) segue a especificação:

| Campo | Regra |
|-------|-------|
| `name` | **Obrigatório.** De 1 a 64 caracteres; só letras minúsculas, números e hífens; sem hífen no começo, no fim nem repetido; **igual ao nome da pasta** |
| `description` | **Obrigatório.** De 1 a 1024 caracteres: diz o que a skill faz **e quando usar** (é por ela que a Yui escolhe a skill) |
| `license` | Opcional. Até 200 caracteres |
| `compatibility` | Opcional. De 1 a 500 caracteres |
| `metadata` | Opcional. Pares de texto para texto, um nível só (até 32 entradas) |
| `allowed-tools` | Reconhecido e **ignorado**: nenhuma skill ganha ferramenta |

Qualquer outro campo faz a skill ser recusada (`campo_desconhecido`).

O **corpo** (depois do segundo `---`) é o texto das instruções, em Markdown, com **menos de 500 linhas** (cerca de 5000 tokens). Ele só é lido quando a skill é usada. Comentários HTML (`<!-- ... -->`) e caracteres invisíveis são removidos antes de chegar ao modelo.

**Referências:** se o corpo citar `references/<arquivo>.md` (caminho relativo, um nível, sem `..`), e esse arquivo **existir** dentro da pasta da skill, o texto dele entra no bloco (até 3 arquivos, 12 KB cada). Qualquer outro caminho (com `..`, absoluto, em subpasta, fora de `references/`) é recusado e nunca é aberto.

O cabeçalho aceita texto simples, aspas, blocos `>` e `|`, comentários `#`, e `metadata` em um nível. Não aceita tags, âncoras nem apelidos do YAML (`yaml_perigoso`), nem listas ou mapas onde cabe texto (`yaml_invalido`).

---

## 📥 5. Instalar à mão

1. Crie a pasta `secrets/skills/<nome>/` (o `<nome>` é o mesmo do campo `name`).
2. Salve o `SKILL.md` dentro dela, em UTF-8.
3. Com `YUI_SKILLS=true`, pergunte à Yui: **"quais skills você tem?"**. A nova skill aparece na lista. Se ela tiver algum problema, aparece uma linha como "Ignorei 1 pasta com problema: nome (motivo)".
4. Peça algo que combine com a descrição.

Instalar é sempre um ato do dono: a Yui não tem comando para baixar nem instalar skills. Skill escrita por outra pessoa é **texto que orienta a Yui**: leia antes de instalar. Os scripts que ela trouxer não rodam, mas o texto das instruções vale.

---

## ✅ 6. Validar

A skill inválida **não carrega**. O motivo vem em uma palavra fixa (na lista, em português; no log, como código):

| Código | Significado |
|--------|-------------|
| `link_simbolico` | A pasta ou o `SKILL.md` é um link simbólico (ou junção do Windows) |
| `fora_da_pasta` | O caminho, resolvido, sai da pasta |
| `sem_skill_md` | A pasta não tem um arquivo chamado exatamente `SKILL.md` |
| `arquivo_grande` | O arquivo passa de 100 KB |
| `utf8_invalido`, `caractere_invalido`, `ilegivel` | O arquivo não é um texto UTF-8 legível, ou tem caracteres de controle |
| `frontmatter_ausente`, `frontmatter_grande` | Falta o cabeçalho `---`, ou ele passa de 8 KB ou 120 linhas |
| `yaml_invalido`, `yaml_perigoso` | O cabeçalho usa algo que não é suportado (ou uma tag, âncora ou apelido do YAML) |
| `campo_desconhecido` | O cabeçalho tem um campo que a especificação não define |
| `nome_ausente`, `nome_invalido`, `nome_diferente_da_pasta` | Problema no `name` |
| `descricao_ausente`, `descricao_invalida` | Problema na `description` |
| `licenca_invalida`, `compatibilidade_invalida`, `metadata_invalido` | Problema no campo opcional |
| `corpo_vazio`, `corpo_grande` | O corpo está vazio, ou passa de 500 linhas ou de cerca de 5000 tokens |
| `nome_duplicado`, `muitas_skills`, `muitas_pastas` | Nome repetido, ou skills ou pastas demais (limites de 100 e 200) |

Cada pasta ignorada vai ao log uma vez, no formato `[Skills] pasta ignorada: <pasta> (<código>).`, sem nenhum trecho do arquivo.

Para conferir o código do carregador: `npm run test:skillspadrao` e `npm run test:skillscerebro`.

---

## 🎯 7. Como a Yui escolhe e usa uma skill

**Quando vale.** Só com `YUI_SKILLS=true` e só se **todas** estas condições forem verdadeiras:

- quem fala é o **dono** da Yui, em **DM ou canal privado** (nunca em canal público);
- a mensagem foi **dirigida à Yui**: DM, menção, o nome dela, resposta a ela ou o comando `/yui`;
- não é voz, conversa espontânea nem texto de terceiros.

Para qualquer outra pessoa ou situação, a conversa é exatamente a de sempre.

**A escolha** é por pontuação de palavras, sem IA: a mensagem e cada skill são reduzidas a palavras (minúsculas, sem acento, sem artigos e verbos genéricos, com plural e variações próximas tratados como a mesma palavra). Cada palavra da mensagem que aparece no **nome** da skill vale 3 pontos e cada uma que só aparece na **descrição** vale 1. A skill precisa de **4 pontos** ou mais. Mensagens muito compridas (mais de 60 palavras) não escolhem skill. Em caso de empate, vence a de mais palavras no nome e, depois, a primeira em ordem alfabética: o resultado não depende da ordem das pastas.

**O uso.** O texto da skill escolhida entra no prompt, depois do restante, entre `[INSTRUÇÕES DA SKILL <nome>, INSTALADA PELO DONO]` e `[FIM DAS INSTRUÇÕES DA SKILL <nome>]`. O bloco avisa o modelo de que aquilo só orienta a resposta. Nessa resposta a Yui fica **sem ferramentas**, e se a resposta do modelo **parecer uma chamada de ferramenta** (um JSON com `tool`, `function` ou `name` e argumentos, por exemplo), ela é trocada por uma resposta segura fixa: o texto de uma skill nunca consegue disparar uma ação. Marcadores iguais aos do bloco dentro do texto da skill (e das referências) são neutralizados, para o texto não fechar o bloco nem abrir outro, inclusive escritos com acento decomposto, letras e colchetes de largura total, espaços estranhos ou caracteres invisíveis. A auditoria ganha uma linha `skill.usada` com o nome da skill. A conversa que usou uma skill (como a que mostrou a lista) **não entra no contexto por horas**, porque o texto vem de um arquivo.

**A lista.** Pedidos curtos como "quais skills você tem?", "lista as suas skills" ou "você tem alguma skill instalada?" são respondidos **por código**, com o nome e a descrição de cada skill válida (e as pastas ignoradas, se houver), sem chamar a IA. "Skill" também é palavra de jogo: a mensagem **inteira** precisa ser só sobre a lista ("qual skill é melhor pro Jett?" ou "tem skill nova no patch?" vão para a IA, como qualquer conversa).

---

## 🛡️ 8. Resumo de segurança

- Desligado por padrão; só o dono; só conversa privada e dirigida à Yui.
- Nada de uma skill é executado, baixado ou instalado; `scripts/` e `allowed-tools` são ignorados.
- A skill não ganha ferramenta, permissão nem rede: é texto de instrução. Uma resposta que pareça chamada de ferramenta é descartada.
- Só leitura, só arquivos dentro da pasta da skill; link simbólico, junção, `..`, caminho absoluto e arquivo fora da pasta são recusados.
- Arquivo grande, cabeçalho perigoso ou fora do padrão não carrega.
- O texto da skill não aparece no log nem na auditoria; a conversa do dono também não.
