# 📅 Google: Agenda e Tarefas (somente leitura)

A Yui pode **ler** a Agenda e as Tarefas do Google de quem a opera (o dono) e responder perguntas como "o que tenho hoje na agenda?". O código do Gmail também existe, mas fica **travado**: só funciona com a rota privada de IA validada, e hoje isso não está ligado.

> **Resumo:** tudo **desligado por padrão** (`YUI_GOOGLE=false`). Só **leitura** (os escopos são todos `readonly`). Só o **dono**, e só em **conversa privada** (DM ou canal privado configurado). Sem a chave, a Yui se comporta exatamente como antes e nunca fala com o Google.

---

## 📂 Sumário

1. [O que ela faz](#-1-o-que-ela-faz)
2. [Permissões pedidas ao Google](#-2-permissões-pedidas-ao-google)
3. [Autorizar (uma vez)](#-3-autorizar-uma-vez)
4. [Ligar na Yui](#-4-ligar-na-yui)
5. [Variáveis](#-5-variáveis)
6. [Expiração da autorização](#-6-expiração-da-autorização)
7. [Segurança e privacidade](#-7-segurança-e-privacidade)
8. [Gmail (travado)](#-8-gmail-travado)
9. [Testes](#-9-testes)

---

## 🧭 1. O que ela faz

**Perguntas por conversa** (só do dono, só em conversa privada; reconhecidas por código, sem IA, e só quando a frase inteira é o pedido):

| Pergunta (exemplos) | O que consulta |
|---------------------|----------------|
| "o que tenho hoje na agenda?", "minha agenda de hoje", "compromissos de hoje" | os eventos de **hoje** |
| "o que tenho amanhã?", "minha agenda de amanhã" | os eventos de **amanhã** |
| "compromissos da semana", "o que tenho essa semana?" | os eventos dos **próximos 7 dias**, a partir de hoje |
| "minhas tarefas", "o que tenho pra fazer?" | as tarefas **pendentes** da lista padrão (com "de hoje" ou "de amanhã": só as que vencem até lá, incluindo as atrasadas) |
| "tenho e-mails novos?" | o Gmail, que está **travado** (veja a [seção 8](#-8-gmail-travado)) |

Os dias são os do **fuso** configurado (`YUI_GOOGLE_FUSO`), não os do servidor. A Yui lê só o necessário: título, hora, local e dia inteiro dos eventos; título e prazo das tarefas. Notas, convidados e outras listas ficam de fora.

**Resumo diário:** com a chave ligada e conectado, o relatório matinal que a Yui manda ao dono **por mensagem privada** ganha a seção "Agenda e tarefas de hoje". Sem a chave, ou sem conexão, o relatório é idêntico ao de sempre. O "resumo do dia" pedido numa conversa (que pode aparecer num canal) nunca leva a agenda do Google.

**Quando algo não dá certo**, a Yui diz uma frase curta, sem detalhe técnico:

- ainda não autorizado: "Ainda não conectei a sua agenda do Google: falta fazer a autorização uma vez.";
- autorização expirada ou revogada: "Preciso que você autorize o Google de novo...";
- o Google recusou a leitura (403): pede para autorizar de novo com todas as permissões;
- rede, prazo ou falha do Google: "Não consegui ler a sua agenda agora. Tenta de novo daqui a pouco.".

Se **outra pessoa** (membro, convidado ou confiável) fizer a mesma pergunta, nada muda para ela: o Google nem é consultado. Se o **dono** perguntar num canal público ou na voz, a Yui responde só que mostra isso por mensagem privada.

> As perguntas por conversa funcionam com o **cérebro separado** (`YUI_CEREBRO_EXTERNO=true`, veja [Variáveis de ambiente](ENVIRONMENT.md#-11-cérebro-separado-e-dois-processos)). O relatório matinal funciona nos dois modos.

---

## 🔐 2. Permissões pedidas ao Google

Todas **somente leitura**:

| Recurso | Permissão (escopo) |
|---------|--------------------|
| Agenda | `https://www.googleapis.com/auth/calendar.events.readonly` (a Yui também aceita `calendar.readonly`, mais ampla, se já estiver na autorização) |
| Tarefas | `https://www.googleapis.com/auth/tasks.readonly` |
| Gmail (opcional, travado) | `https://www.googleapis.com/auth/gmail.readonly` |

Como o Google classifica cada uma (sensível ou restrita) **não foi confirmado** aqui: na tela de consentimento o Google mostra o que cada permissão permite; **confira lá** antes de aceitar. Num app de computador **não existe consentimento incremental**: todas as permissões são pedidas de uma vez, na mesma autorização.

---

## 🪪 3. Autorizar (uma vez)

O Google **não aceita** o fluxo de dispositivo (o de "digite este código na TV") para Agenda, Tarefas ou Gmail. O caminho é o de **app instalado com retorno local**, feito **uma vez, num PC com navegador**; o arquivo gerado é levado para o servidor da Yui.

**Antes:** é preciso ter, no console do Google, um projeto com as APIs usadas ativadas (Google Calendar API e Google Tasks API; Gmail API só para o Gmail), a tela de consentimento configurada com a sua conta como **usuário de teste** e um **cliente OAuth do tipo "App para computador"** (Desktop). Baixe o JSON desse cliente.

**Depois**, no PC com navegador, na pasta da Yui:

```bash
node scripts/google-autorizar.mjs --cliente caminho/do/cliente.json
```

| Opção | O que faz |
|-------|-----------|
| `--cliente <arquivo>` | O JSON do cliente OAuth (tipo "App para computador"). Obrigatório. O do tipo "Aplicativo da Web" é recusado. |
| `--saida <arquivo>` | Onde gravar o arquivo de token. Padrão: `secrets/google-token.json`. |
| `--gmail` | Pede também a permissão do Gmail (somente leitura). Só se for ligar o Gmail. |
| `--porta <n>` | Porta local do retorno. Padrão: uma porta livre. |
| `--sem-navegador` | Só imprime o link, sem tentar abrir o navegador. |
| `--tempo <s>` | Quanto esperar a autorização (padrão 300 s). |

O script abre um servidor **só em `127.0.0.1`**, usa **PKCE (S256)** e um `state`, **imprime o link** de consentimento (e tenta abrir o navegador, sem exigir isso), recebe o código, troca por tokens e grava o arquivo com a permissão restrita ao seu usuário. Ele **nunca imprime** segredo, código nem token. Só aceita o retorno com o `state` certo.

Na tela do Google:

- **Marque todas as caixas** de permissão (o Google deixa desmarcar uma a uma; sem a caixa, a Yui não lê aquele recurso, e o script avisa qual faltou).
- Se aparecer **"O Google não verificou este app"**: é esperado para um app seu em modo de teste. Clique em **Avançado** e depois em **Acessar ... (não seguro)**. Só continue se o app e a conta forem os seus.

---

## 🔌 4. Ligar na Yui

1. **Copie** o arquivo de token para o servidor da Yui, no caminho de `YUI_GOOGLE_TOKEN_ARQUIVO` (padrão: `secrets/google-token.json`, dentro da pasta da Yui), por um meio seguro (cabo, pen drive, `scp` por uma rede privada). Nunca por Discord, e-mail ou uma nuvem aberta. Depois **apague a cópia do PC** ou guarde-a num lugar seguro.
2. No `.env` do servidor: `YUI_GOOGLE=true` (e `YUI_GOOGLE_FUSO=<seu fuso>` se não for `America/Sao_Paulo`).
3. **Reinicie** a Yui.

---

## ⚙️ 5. Variáveis

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_GOOGLE` | Liga a leitura da Agenda e das Tarefas do dono. Desligado, nada muda e a Yui nunca fala com o Google | `false` |
| `YUI_GOOGLE_GMAIL` | Libera o código do Gmail (somente leitura). **Só funciona** com a rota privada de IA validada (hoje desligada); sem ela, nada é baixado | `false` |
| `YUI_GOOGLE_TOKEN_ARQUIVO` | Caminho do arquivo da autorização | `secrets/google-token.json` |
| `YUI_GOOGLE_FUSO` | Fuso (nome IANA, como `America/Cuiaba`) dos "hoje", "amanhã" e "semana" | `America/Sao_Paulo` |

---

## ⏳ 6. Expiração da autorização

O Google pode **invalidar** a autorização:

- num projeto em modo **"Testing"**, a autorização de permissões sensíveis **expira em cerca de 7 dias** (o que muda ao publicar o app **não foi confirmado**: confira na documentação do Google antes de decidir);
- se ficar **6 meses sem uso**;
- se a pessoa **revogar** o acesso (https://myaccount.google.com/permissions);
- se a senha for alterada, para autorizações com permissões do Gmail.

Quando o Google recusa (`invalid_grant`), a Yui marca a integração como "precisa autorizar de novo", **avisa o dono uma vez** por mensagem privada e **para de tentar**. A marca fica dentro do arquivo de token: reiniciar a Yui não repete o aviso, e um arquivo **novo** (de uma nova autorização) volta a funcionar sozinho. Para renovar: rode o script de novo, copie o arquivo e reinicie.

Falhas passageiras (rede, prazo, erro do servidor do Google) **não** contam como expiração: a Yui espera 30 segundos antes de tentar de novo.

---

## 🛡️ 7. Segurança e privacidade

- O arquivo de token é um **segredo**: tem o cliente e o refresh token. É gravado de forma **atômica** e com a **permissão restrita** ao dono do processo (no Windows por SID, conferida; fora dele, `chmod 600`). A pasta `secrets/` é ignorada pelo git.
- A Yui nunca escreve token, segredo, corpo de resposta ou texto de erro do Google no log, nos avisos ou nas mensagens.
- Cada chamada ao Google tem prazo curto e **uma tentativa** só; só leitura (`GET`).
- O que vem do Google (título de evento, local, título de tarefa) é **dado não confiável**: pode ter sido escrito por outra pessoa (um convite, por exemplo). Entra no prompt **cercado** como dado, sem colchetes nem quebras de linha que imitem um cabeçalho, **sem ferramentas** nessa chamada, e a resposta do modelo que parecer uma chamada de ferramenta é descartada.
- A conversa que leva dados do Google é tratada como **sensível**, igual à do dono em DM: **nunca** vai a provedor anônimo. Se o perfil privado de IA estiver configurado, ela vai por ele; sem ele, segue o fluxo de sempre, que já nunca usa provedor anônimo. A troca **não entra** no contexto por horas.
- Os endereços do Google ficam em **um único arquivo** (`src/integrations/google/endpoints.js`).

---

## ✉️ 8. Gmail (travado)

O código mínimo de listar e ler mensagens (`gmail.readonly`) existe em `src/integrations/google/gmail.js`, mas só roda com **as duas** condições:

1. `YUI_GOOGLE_GMAIL=true`;
2. a **rota privada de IA validada** (`estadoDaRotaPrivada().estado === 'validada'`, consultada a cada uso).

Hoje o perfil privado está desligado, então o Gmail **nunca** funciona. Falha **fechada**: sem as duas condições, nenhuma chamada ao Google é feita (o e-mail nem é baixado), nada entra no prompt, nenhuma IA é chamada, e a Yui responde "Ainda não leio e-mails: falta a rota privada de IA.". O conteúdo de um e-mail nunca vai a um provedor sem essa rota.

---

## 🧪 9. Testes

Tudo contra um **Google falso** em `127.0.0.1`, aberto pelo próprio teste (nada do Google de verdade é tocado):

```bash
npm run test:google           # a unidade: endereços, arquivo, renovação, expiração, Agenda, Tarefas, dados cercados, pré-rota, Gmail travado, relatório
npm run test:googleautorizar  # o script de autorização de verdade (PKCE, state, retorno local, arquivo restrito)
```

[🏠 Voltar ao índice](../README.md)
