# 📅 Google: Agenda e Tarefas (somente leitura)

A Yui pode **ler** a Agenda e as Tarefas do Google de quem a opera (o dono) e responder perguntas como "o que tenho hoje na agenda?". Tudo isso exige a **rota privada de IA validada** (o [portão](#-7-o-portão-da-rota-privada-de-ia)): sem ela a Yui não lê nada do Google. O código do Gmail também existe, mas fica **travado** do mesmo jeito, **sem exceção possível**, e hoje a rota privada não está ligada.

> **Resumo:** tudo **desligado por padrão** (`YUI_GOOGLE=false`). Só **leitura** (os escopos são todos `readonly`). Só o **dono**, e só em **conversa privada** (DM ou canal privado configurado). Sem a chave, a Yui se comporta exatamente como antes e nunca fala com o Google. Com a chave, ainda é preciso a **rota privada de IA validada**: os dados pessoais do Google não vão a um provedor de IA público ou gratuito só porque a conversa é privada. Uma **exceção explícita do dono** (`YUI_GOOGLE_SEM_ROTA_PRIVADA=true`, desligada por padrão) dispensa essa exigência só para a Agenda e as Tarefas, nunca para o Gmail.

---

## 📂 Sumário

1. [O que ela faz](#-1-o-que-ela-faz)
2. [Permissões pedidas ao Google](#-2-permissões-pedidas-ao-google)
3. [Autorizar (uma vez)](#-3-autorizar-uma-vez)
4. [Ligar na Yui](#-4-ligar-na-yui)
5. [Variáveis](#-5-variáveis)
6. [Expiração da autorização](#-6-expiração-da-autorização)
7. [O portão da rota privada de IA](#-7-o-portão-da-rota-privada-de-ia)
8. [Segurança e privacidade](#-8-segurança-e-privacidade)
9. [Gmail (travado)](#-9-gmail-travado)
10. [Testes e o que ainda não foi testado](#-10-testes-e-o-que-ainda-não-foi-testado)

---

## 🧭 1. O que ela faz

**Perguntas por conversa** (só do dono, só em conversa privada; reconhecidas por código, sem IA, e só quando a frase inteira é o pedido):

| Pergunta (exemplos) | O que consulta |
|---------------------|----------------|
| "o que tenho hoje na agenda?", "minha agenda de hoje", "compromissos de hoje" | os eventos de **hoje** |
| "o que tenho amanhã?", "minha agenda de amanhã" | os eventos de **amanhã** |
| "compromissos da semana", "o que tenho essa semana?" | os eventos dos **próximos 7 dias**, a partir de hoje |
| "minhas tarefas", "o que tenho pra fazer?" | as tarefas **pendentes** da lista padrão (com "de hoje" ou "de amanhã": só as que vencem até lá, incluindo as atrasadas) |
| "quando é o próximo aniversário?", "tem aniversário hoje?", "aniversários do mês" | o **calendário de aniversários** dos contatos, lido direto (ele é um calendário à parte; não precisa de permissão nova). Nome de pessoa na frase não é reconhecido |
| "e nesta semana?", "e amanhã?", "e as tarefas?" | a **continuação**: só vale até 10 minutos depois de uma consulta da Yui ao Google, só para o dono e em conversa privada; consulta o Google de novo |
| "tenho e-mails novos?" | o Gmail, que está **travado** (veja a [seção 9](#-9-gmail-travado)) |

Uma pergunta sobre a **sua** agenda, tarefas ou aniversários que a Yui não entende (por exemplo "qual é o meu compromisso mais importante desse mês?") recebe uma **orientação fixa** com exemplos de pedidos curtos: nunca a IA livre, que poderia inventar "agenda livre" ou dizer que não tem acesso. Pedido de criar, anotar ou marcar não entra nisso.

Os dias são os do **fuso** configurado (`YUI_GOOGLE_FUSO`, ou o do dono, `YUI_FUSO`, se a primeira não existir), não os do servidor. A Yui lê só o necessário: título, hora, local e dia inteiro dos eventos; título e prazo das tarefas. Notas, convidados e outras listas ficam de fora.

Ficam **fora** da agenda: os eventos cancelados, os **convites que o dono recusou** e os eventos de **dia inteiro de outro dia** (o Google decide o dia inteiro pelo fuso da agenda, então a Yui confere as datas por conta própria; o fim de um evento de dia inteiro é exclusivo). Quando há mais coisas do que cabe numa resposta do Google, a Yui **segue as páginas** (até 5 de eventos e 10 de tarefas) antes de ordenar e cortar a lista.

**Resumo diário:** com a chave ligada, o portão aberto e conectado, o relatório matinal que a Yui manda ao dono **por mensagem privada** ganha a seção "Agenda e tarefas de hoje". Sem a chave, com o portão fechado ou sem conexão, o relatório é idêntico ao de sempre (e nada é consultado no Google). O botão "enviar relatório agora" do painel também leva a seção (ele manda por mensagem privada). A prévia do relatório na tela do painel e o "resumo do dia" pedido numa conversa (que pode aparecer num canal) nunca levam a agenda do Google.

**Quando algo não dá certo**, a Yui diz uma frase curta, sem detalhe técnico:

- sem a rota privada de IA validada (e sem a exceção do dono): "Ainda não leio a sua agenda: falta a rota privada de IA." (ou "Ainda não leio as suas tarefas: falta a rota privada de IA."), e **nada** é consultado no Google;
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
2. No `.env` do servidor: `YUI_GOOGLE=true` (o fuso vem de `YUI_FUSO`, o do dono, padrão `America/Sao_Paulo`; ponha `YUI_GOOGLE_FUSO=<seu fuso>` só se o da agenda for outro). **Atenção:** sem a rota privada de IA validada a Yui não lê nada (veja o [portão](#-7-o-portão-da-rota-privada-de-ia)); a exceção `YUI_GOOGLE_SEM_ROTA_PRIVADA=true` é uma decisão sua, com o que ela implica.
3. **Reinicie** a Yui.

---

## ⚙️ 5. Variáveis

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_GOOGLE` | Liga a leitura da Agenda e das Tarefas do dono. Desligado, nada muda e a Yui nunca fala com o Google | `false` |
| `YUI_GOOGLE_SEM_ROTA_PRIVADA` | **Exceção explícita do dono.** Só o texto exato `true` (minúsculo e sem espaços: `True`, `TRUE`, ` true ` e `1` não valem) dispensa o portão da rota privada de IA **para a Agenda e as Tarefas** (nunca para o Gmail): o texto da agenda passa pela IA em nuvem, sempre por provedor **não anônimo**. Só vale com `YUI_GOOGLE=true` | `false` |
| `YUI_GOOGLE_GMAIL` | Libera o código do Gmail (somente leitura). **Só funciona** com a rota privada de IA validada (hoje desligada); sem ela, nada é baixado | `false` |
| `YUI_GOOGLE_TOKEN_ARQUIVO` | Caminho do arquivo da autorização | `secrets/google-token.json` |
| `YUI_GOOGLE_FUSO` | Fuso (nome IANA, como `America/Cuiaba`) dos "hoje", "amanhã" e "semana". Se não existir, vale `YUI_FUSO` | o valor de `YUI_FUSO` (`America/Sao_Paulo` se também faltar) |

---

## ⏳ 6. Expiração da autorização

O Google pode **invalidar** a autorização:

- num projeto em modo **"Testing"** (o modo de teste do console do Google, tipo de usuário "Externo"), a autorização **expira em 7 dias** (documentação oficial do Google, consultada em 19/11/2026: ["Manage App Audience"](https://support.google.com/cloud/answer/15549945) e ["Using OAuth 2.0 to Access Google APIs"](https://developers.google.com/identity/protocols/oauth2)): nesse modo, conte com renovar a autorização toda semana. Para um app pessoal de um único usuário a documentação cita duas saídas: o tipo de usuário **"Pessoal"** (só a conta que criou o app; sem a expiração de 7 dias de teste, sem verificação e sem a tela de "app não verificado"; é uma escolha única na criação de um **projeto novo**) e **publicar** o app Externo ("In production"; sem verificação o Google mostra a tela de app não verificado e limita a 100 usuários novos). **Não foi confirmado** que um app Externo publicado e **não verificado** deixa de expirar em 7 dias (a documentação oficial não diz; fontes de terceiros divergem), nem que o modo Pessoal aceita os escopos da Agenda e das Tarefas: confira no seu console antes de decidir;
- se ficar **6 meses sem uso**;
- se a pessoa **revogar** o acesso (https://myaccount.google.com/permissions);
- se a senha for alterada, para autorizações com permissões do Gmail.

Quando o Google recusa (`invalid_grant`), a Yui marca a integração como "precisa autorizar de novo", **para de tentar** e **avisa o dono** por mensagem privada. O aviso só conta como **entregue depois que a mensagem de fato saiu**: se o Discord estiver fora do ar ou a mensagem falhar, a Yui tenta de novo no próximo uso (no mínimo a cada 15 minutos) até a entrega ser confirmada, uma entrega por vez. Confirmada, a hora do aviso fica dentro do arquivo de token e **nunca mais se repete**: um processo novo lê a marca, não chama o Google e não manda outra mensagem, nem 1 minuto, nem 48 horas depois. Um arquivo **novo** (de uma nova autorização) volta a funcionar sozinho. Se a pasta do arquivo não puder ser gravada, a marca fica só em memória e um reinício tenta uma vez e avisa de novo. Para renovar: rode o script de novo, copie o arquivo e reinicie.

Falhas passageiras (rede, prazo, erro do servidor do Google) **não** contam como expiração: a Yui espera 30 segundos antes de tentar de novo.

---

## 🔒 7. O portão da rota privada de IA

Os dados pessoais do Google (agenda, tarefas, e-mail) **não podem ir a um provedor de IA público ou gratuito só porque a conversa é privada**. Por isso, **antes de qualquer consulta ao Google** (inclusive a renovação do token de acesso) e antes de qualquer dado entrar num prompt, a Yui exige:

- `estadoDaRotaPrivada().estado === 'validada'` (a rota privada de IA, verificada por uma sonda e lida pelo leitor estrito do cabeçalho de decisão do OmniRoute), **consultado a cada uso**: se a rota for bloqueada depois, o próximo pedido já fecha;
- sem a rota validada: **falha fechada**. Nada é baixado do Google, nenhuma IA é chamada, **não há fallback** para provedor público e a Yui responde uma frase curta e fixa ("Ainda não leio a sua agenda: falta a rota privada de IA."). Qualquer estado que não seja `validada` (`desligada`, `incompleta`, `nao-verificada`, `nao-validada`, `bloqueada`, ou um estado desconhecido) fecha o portão;
- o mesmo portão vale para a seção "Agenda e tarefas de hoje" do relatório matinal (sem a rota, a seção não existe e o relatório é o de sempre).

**A exceção explícita do dono.** `YUI_GOOGLE_SEM_ROTA_PRIVADA=true` (padrão `false`; só o texto exato `true` vale, nada de `1`, `sim` ou `on`, e só com `YUI_GOOGLE=true`) dispensa o portão **somente para a Agenda e as Tarefas**. É uma decisão expressa de quem aceita que o texto da agenda e das tarefas passe pela IA em nuvem: a conversa continua sensível (**nunca** provedor anônimo, nunca no contexto por horas, sem ferramentas e sem busca), mas o provedor que responder pode ser um serviço de nuvem comum, e os planos gratuitos de alguns provedores podem usar o conteúdo das conversas para melhorar os produtos deles. Quando a rota privada está validada, vale a rota (a exceção nem é usada). Com a exceção em uso, a Yui deixa **uma** linha de aviso no log por processo, sem nenhum conteúdo.

**O Gmail nunca é dispensado.** Nenhuma chave dispensa o portão do Gmail: só `YUI_GOOGLE_GMAIL=true` **e** a rota privada validada o abrem (veja a [seção 9](#-9-gmail-travado)).

---

## 🛡️ 8. Segurança e privacidade

- O arquivo de token é um **segredo**: tem o cliente e o refresh token. É gravado de forma **atômica** e com a **permissão restrita** ao dono do processo (no Windows por SID, conferida; fora dele, `chmod 600`). A pasta `secrets/` é ignorada pelo git.
- A Yui nunca escreve token, segredo, corpo de resposta ou texto de erro do Google no log, nos avisos ou nas mensagens.
- Cada chamada ao Google tem prazo curto e **uma tentativa** só; só leitura (`GET`).
- O que vem do Google (título de evento, local, título de tarefa) é **dado não confiável**: pode ter sido escrito por outra pessoa (um convite, por exemplo). Entra no prompt **cercado** como dado, sem colchetes nem quebras de linha que imitem um cabeçalho, **sem ferramentas** nessa chamada, e a resposta do modelo que parecer uma chamada de ferramenta é descartada.
- A conversa que leva dados do Google é tratada como **sensível**, igual à do dono em DM: **nunca** vai a provedor anônimo. Com a rota privada validada, ela vai pelo perfil privado; só com a exceção do dono ela segue o fluxo de sempre (provedor não anônimo da cadeia). A troca **não entra** no contexto por horas.
- Os endereços do Google ficam em **um único arquivo** (`src/integrations/google/endpoints.js`).

---

## ✉️ 9. Gmail (travado)

O código mínimo de listar e ler mensagens (`gmail.readonly`) existe em `src/integrations/google/gmail.js`, mas só roda com **as duas** condições:

1. `YUI_GOOGLE_GMAIL=true`;
2. a **rota privada de IA validada** (`estadoDaRotaPrivada().estado === 'validada'`, consultada a cada uso), **sem exceção possível** (nem `YUI_GOOGLE_SEM_ROTA_PRIVADA` o dispensa).

Hoje o perfil privado está desligado, então o Gmail **nunca** funciona. Falha **fechada**: sem as duas condições, nenhuma chamada ao Google é feita (o e-mail nem é baixado), nada entra no prompt, nenhuma IA é chamada, e a Yui responde "Ainda não leio e-mails: falta a rota privada de IA.". O conteúdo de um e-mail nunca vai a um provedor sem essa rota.

---

## 🧪 10. Testes e o que ainda não foi testado

Tudo contra um **Google falso** em `127.0.0.1`, aberto pelo próprio teste (nada do Google de verdade é tocado):

```bash
npm run test:google           # a unidade e o fluxo completo: endereços, arquivo, renovação, expiração, Agenda, Tarefas (páginas, dia inteiro, convite recusado), dados cercados, pré-rota, portão, exceção, Gmail travado, relatório; e do script de autorização à leitura, à renovação, à expiração e ao aviso
npm run test:googleautorizar  # o script de autorização de verdade (PKCE, state, retorno local, arquivo restrito)
```

**O que ainda NÃO foi testado** (só existe o Google falso): a autorização feita no Google de verdade (a tela de consentimento, o aviso de "app não verificado" e as respostas reais), um `invalid_grant` real, a expiração real de cerca de 7 dias do modo "Testing", e a execução da Yui como SYSTEM no servidor. Os testes do portão usam a máquina de estados real da rota privada contra um OmniRoute falso, mas o cabeçalho de decisão do OmniRoute de verdade segue pendente de confirmação.

[🏠 Voltar ao índice](../README.md)
