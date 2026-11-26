# Yui no chat de uma live do YouTube

Passo a passo para quem não programa. A função vem **desligada**; nada muda até você seguir os passos abaixo.

Os nomes de botões do site do Google mudam de vez em quando. Se algum não bater, procure o equivalente.

## O que ela faz

- Entra no chat da live que você mandar e responde quando alguém a chama pelo nome ("yui").
- De vez em quando puxa assunto (só com o chat ativo, no máximo 12 vezes por live).
- Fala com todo mundo como público, inclusive com você. No chat ela não usa memória, ferramentas, busca nem agenda, e não obedece ordens.
- Mensagens de até 200 caracteres, sem link. No máximo 5 a cada 15 minutos (20 por hora), e cada pessoa consegue até 3 chamadas a cada 15 minutos. Num ensaio com uma só conta, a 4ª chamada fica sem resposta.
- Mensagens com link, ofensa ou tentativa de dar ordens são ignoradas.
- O texto do chat passa pela IA em nuvem que a Yui já usa.

## Antes de tudo

A versão da Yui com esta função precisa estar no notebook (a atualização de sempre).

## 1. Criar a conta e o canal da Yui

1. Crie uma conta Google só para a Yui (não use a sua).
2. Entre no YouTube com ela e crie o canal (ícone da conta > Criar canal).
3. Faça isso o quanto antes. Canal recém-criado pode ter restrições do YouTube (confira no próprio site).

## 2. Criar o projeto e a credencial no Google

Pode usar a conta da Yui ou a sua. Use um projeto **novo**, só para a live: a cota diária é por projeto.

1. Abra <https://console.cloud.google.com> e crie um projeto (por exemplo, "Yui Live").
2. Em **APIs e serviços > Biblioteca**, procure **YouTube Data API v3** e clique em **Ativar**.
3. Abra a **Plataforma de autenticação do Google** (ou "Tela de consentimento OAuth"), preencha o nome do app e o e-mail, e escolha o público **Externo**.
4. Em **Público-alvo**, escolha uma das duas opções:
   - **Publicar o app** (recomendado): a autorização não vence a cada 7 dias. O Google mostrará o aviso "app não verificado".
   - Ficar em **Teste**: adicione o e-mail da conta da Yui em **Usuários de teste**. Nesse modo a autorização vence em 7 dias.
5. Em **Clientes** (ou "Credenciais"), crie um **ID do cliente OAuth** do tipo **App para computador** e baixe o arquivo JSON.

## 3. Autorizar o canal da Yui

O jeito mais simples é fazer no próprio notebook, na tela dele:

1. Copie o JSON baixado para o notebook (por exemplo, para a pasta Downloads).
2. Abra o **PowerShell como administrador** e entre na pasta da Yui. O primeiro comando abaixo mostra qual é a pasta; no segundo, troque pelo caminho que apareceu:

   ```powershell
   (Get-ScheduledTask YuiBot).Actions.WorkingDirectory
   cd "C:\caminho\que\apareceu"
   ```

   Se der erro de tarefa não encontrada, troque `YuiBot` por `YuiSupervisor`.
3. Rode:

   ```powershell
   node scripts/youtube-autorizar.mjs --cliente "C:\caminho\do\cliente.json"
   ```

4. O navegador abre. Entre com a **conta da Yui** e, se o Google perguntar, escolha o **canal da Yui**.
5. No aviso "o Google não verificou este app": **Avançado > Acessar**.
6. Confira no PowerShell o nome do canal autorizado. Se não for o da Yui, rode de novo.
7. Apague o JSON baixado.

O arquivo é gravado em `secrets/youtube-token.json`, separado do Google da Agenda. Ele só pode ser lido pelo seu usuário, pelo sistema (como a Yui roda) e pelos administradores. É um segredo: não mande por Discord, e-mail nem nuvem.

**Se preferir autorizar no seu PC:** rode o mesmo comando lá, copie o `youtube-token.json` para a pasta `secrets` da Yui no notebook (pen drive ou `scp`), apague a cópia do PC e, no notebook, como administrador, dentro da pasta da Yui:

```powershell
icacls secrets\youtube-token.json /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F"
```

A permissão que o Google mostra é ampla (ver, editar e apagar coisas do canal), porque não existe uma só para o chat. Por isso a conta deve ser só da Yui.

## 4. Ligar

No painel, em **Configuração > Conversa**, ligue **Yui no chat de uma live do YouTube** (ou ponha `YUI_YOUTUBE_LIVE=true` no `.env`) e **reinicie a Yui**.

## 5. Moderadora (opcional)

Na sua live, clique no nome da Yui no chat e escolha **Adicionar moderador**. Isso ajuda a ela não ser barrada por modo lento ou filtros (confira o comportamento atual no YouTube). Não aumenta a cota da API, e ela não modera nada.

## 6. Testar numa live não listada

1. Inicie uma transmissão **não listada**, com o chat ligado. (Ativar transmissões ao vivo num canal pode levar até 24 horas na primeira vez: faça antes.) Vídeo privado não serve.
2. Mande para a Yui, na DM do Discord: `entra na live https://youtube.com/live/...`
3. Espere a confirmação. Com **outra conta**, escreva no chat: `oi yui`.
4. A resposta pode levar de 15 a 60 segundos. O que já estava no chat antes de ela entrar é ignorado.
5. Mande `como está a live` e depois `sai da live`.

## Comandos

Só você, na **DM do Discord** (mensagem comum, digitada) ou no **chat do app**:

| Mensagem | O que faz |
|---|---|
| `entra na live <link>` | entra no chat |
| `sai da live` | sai na hora |
| `como está a live` | diz se está na live, quantas respostas deu e a cota contada |

"agora" e "por favor" no fim também valem. Outras variações não são comando: confira se veio a resposta "Saí da live.".

Não valem por voz, em servidor, em mensagem encaminhada ou com anexo. Nada do que for escrito no chat da live é comando. No app, a Yui não distingue o que foi ditado pelo teclado do que foi digitado.

## Quando ela para

Ela avisa você por DM quando a live acaba, quando o YouTube recusa o acesso (removida, banida, sem permissão), quando a cota acaba ou quando um erro não passa. Se a DM não puder ser entregue (internet fora, por exemplo), ela tenta de novo a cada minuto.

Se a Yui ou o notebook **reiniciar** durante a live, ela **não volta sozinha**: avisa por DM e você manda o comando de novo.

**Para parar:** `sai da live`. Em emergência: esconda a Yui no chat do YouTube, desligue a opção no painel e reinicie, ou remova o acesso do app em <https://myaccount.google.com/permissions> (entrando com a conta da Yui).

## Cota diária (conta para uma live de 4 horas)

Custos por chamada, conferidos na [tabela de custos do Google](https://developers.google.com/youtube/v3/determine_quota_cost) em 26/11/2026:

| Chamada | Unidades |
|---|---|
| achar o chat (`videos.list`) | 1 |
| ler o chat (`liveChatMessages.list`) | 5 |
| escrever (`liveChatMessages.insert`) | 20 |

Cota padrão de um projeto: **10.000 unidades por dia**. A Yui reserva 1.000 e usa até 9.000.

| Item (4 horas) | Conta | Unidades |
|---|---|---|
| leituras, uma a cada 15 s | 960 x 5 | 4.800 |
| mensagens, no teto de 5 a cada 15 min | 80 x 20 | 1.600 |
| entrar | 1 | 1 |
| **total** | | **6.401** |

Sobram cerca de 2.600 unidades para o ensaio no mesmo dia (20 minutos de teste gastam perto de 500).

Pressupostos e o que conferir:

- O projeto não é usado por outra coisa.
- A cota zera à meia-noite do horário do Pacífico (4h da manhã em Cuiabá, nesta época do ano).
- A Yui conta só o que ela mesma gastou **desde que ligou**: reiniciar zera essa contagem, mas não a do Google. Chamadas que falham também podem gastar.
- **Confira no console** (APIs e serviços > YouTube Data API v3 > Cotas) o limite real do seu projeto e, depois do ensaio, o quanto foi gasto.
- A documentação pode mudar os custos; confira antes de uma live longa.

## Problemas comuns

| Resposta da Yui | O que fazer |
|---|---|
| "Falta a autorização do canal" | repita o passo 3 |
| "O YouTube recusou a autorização" | repita o passo 3 (no modo Teste ela vence em 7 dias) |
| "O YouTube negou o acesso" | confira se a API foi ativada no projeto e se a conta não está bloqueada no chat |
| "Não achei o chat" | a transmissão ainda não começou ou o chat está desligado |
| Ela respondeu a um comando como conversa comum | a chave está desligada, faltou reiniciar ou a frase não é exatamente uma das três |
