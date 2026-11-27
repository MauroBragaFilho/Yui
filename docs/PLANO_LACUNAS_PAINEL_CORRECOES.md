# Complemento ao plano das lacunas do painel: as correções pedidas pela Liz

Alice, 27/11/2026. Complementa o [PLANO_LACUNAS_PAINEL.md](PLANO_LACUNAS_PAINEL.md).

**De onde vem:** o parecer da Liz sobre as entregas A a F, resumido no fim do [RELATORIO_PLANO_LACUNAS_PAINEL.md](RELATORIO_PLANO_LACUNAS_PAINEL.md). Ela deu **parecer favorável com ressalvas** e não descartou nenhuma entrega. Pediu uma rodada de correções antes de publicar.

**Estado:**
- Nada deste complemento foi implementado.
- As entregas A a F estão sem commit no working tree de `D:\Projetos\Yui`.
- A publicação continua depois das lives de 28-29/11, com o parecer da Liz sobre estas correções e o OK do Braga.

## O que conferi no código antes de propor

1. **Planos (`src/core/planos/ferramentas.js`):**
   - Todas as ferramentas de plano são **só de leitura** (`TOOL_ACCESS.READ`).
   - Cada passo já tem uma frase montada **por código** (`frase()`), sem IA. É essa frase que vai para a DM.
   - Os argumentos são de dois tipos:
     - **listas fechadas**, sem nada da pessoa: `periodo`, `pasta` e `parte`;
     - **texto livre:** o `nome` da busca na biblioteca, a `consulta` da pesquisa e o nome da `lista`.
   - Só a `pesquisa` manda texto para fora do computador, para o buscador.
2. **Login do painel (`src/core/api/server.js` e `auth.js`):**
   - O painel entra com usuário e senha ou com a chave de 5 minutos que chega pela DM.
   - A sessão vale 12 horas e vai no cabeçalho `Authorization: Bearer`.
   - **Não há cookie.** O navegador nunca manda a credencial sozinho para outro site, e o CORS só aceita as origens da lista (nunca `*`). Por isso o CSRF clássico não se aplica.
   - O risco real é **roubo da sessão**: o token fica no armazenamento do navegador. A confirmação reforçada (C2) responde a esse risco.
3. **Somente leitura e reautorização do Google (`permissionMatrix.js`):**
   - A reautorização **não está classificada como leitura**. Ela é `modifies` (grava) e é `ASK` para o dono.
   - Em `enforce` normal, o painel pede confirmação e funciona.
   - Só com `YUI_READ_ONLY=true` ela é negada. É a regra 1 da política: o modo somente leitura congela toda gravação, inclusive o cofre do painel.
   - O relatório deu a entender o contrário; a frase saiu ambígua e foi erro meu.
4. **Google:**
   - Os escopos que contam são os que **o Google devolveu**, não os pedidos (`troca.js`, `reautorizar.js`).
   - O Gmail tem código, mas só roda com a chave `YUI_GOOGLE_GMAIL` **e** a rota privada de IA validada (`portao.js`).
   - `auth.js` recusa o recurso cuja autorização guardada não tem o escopo.
   - O painel nunca pede o Gmail.
5. **Limite de imagem:**
   - O app usa a mesma função `takeImageQuota` do Discord (`imageIntent.js`), mas ela conta na memória de **cada processo**.
   - O Discord conta no bot e o app conta no cérebro. Por isso o limite dobra.
   - Com o cérebro dentro do bot (um processo só), o limite já é um só.
6. **Cofre (`painelConfig.js`):**
   - Toda gravação acontece no cérebro, inclusive a do Discord, que vem pelo canal.
   - Cada gravação lê e grava o arquivo inteiro de uma vez, sem nada no meio. Uma chave nunca apaga a outra.
   - Na **mesma** chave vale a última gravação.

## Correções propostas

### C1. Resumo seguro para aprovar plano pelo painel (desvio 1, pergunta 1)

O servidor monta o resumo por código, a partir do plano guardado. Para cada passo, o resumo mostra:

| Campo | Exemplo | Origem |
|---|---|---|
| A ação | "Ler a sua agenda do Google (os próximos 7 dias)" | a `frase()`, com os valores de lista fechada |
| O serviço | Google Agenda, Google Tarefas, Biblioteca (BDS), Web, Lembretes, Listas, Computador | fixo por ferramenta |
| O acesso | Só leitura | `TOOL_ACCESS` |
| Sai do computador? | "Sim, para o buscador" / "Lê da sua conta Google" / "Não" | fixo por ferramenta |
| Texto livre | "busca de 18 caracteres (o texto está na DM)" | só o tamanho, nunca o texto |

**Regras:**
- Junto vão o hash curto, a versão e a validade, como hoje. Qualquer mudança no plano invalida a aprovação, como já acontece.
- **Plano com pesquisa na web se aprova só pela DM.** É o único passo que manda o texto da pessoa para fora, e no painel o texto não aparece. O painel mostra o resumo e o aviso "aprove este pela DM", e o `POST /decisao` recusa aprovar com 409. Recusar continua valendo.
- Os textos livres continuam sem sair do servidor, como a entrega B garante.

**Testes:**
- O JSON nunca tem os textos livres, e os valores de lista fechada aparecem.
- Um plano com `pesquisa` não se aprova pelo painel, mas se recusa.
- O hash e a validade continuam conferidos.
- Mutação: tirar a trava da pesquisa e ver o teste falhar.

### C2. Confirmação reforçada nas ações críticas (desvio 2, pergunta 2)

Reaproveita a chave pela DM que o login já usa (`createPairing`), sem senha nova e sem outro sistema de credencial.

**Como funciona:**
1. O painel pede uma chave de confirmação para uma ação e um alvo (o plano com o hash, ou "Google").
2. A Yui manda pela DM do dono uma chave de 6 dígitos, que vale 5 minutos e uma vez só. A DM diz para qual ação ela serve.
3. A ação só acontece com a chave certa, para aquela ação e aquele alvo.

**Regras:**
- A chave de uma ação não serve para outra.
- Errar 5 vezes trava por 15 minutos, como no login, e avisa o dono.
- A auditoria registra o pedido e o uso, sem a chave.

**Onde vale:**
- **Aprovar plano.** Recusar não pede chave.
- **Começar a reautorização do Google.**

As outras ações continuam como estão: só do dono, com confirmação na tela, auditoria e limite de repetição. São entrar e sair da live, apagar da continuidade, republicar o GTA e o rádio. Pedir chave para tudo deixaria o painel pesado sem ganho real; sair da live, por exemplo, precisa funcionar sempre.

**Somente leitura:**
- Recomendo manter a reautorização **negada** com `YUI_READ_ONLY=true`. Esse modo é o "congelar tudo", e abrir exceção para gravar credencial enfraquece justamente ele.
- Com o modo desligado, a reautorização segue como `ASK` mais a chave pela DM.
- A Liz pediu uma exceção explícita. É decisão do Braga (decisão 4).

**Testes:**
- Sem chave, com a chave errada, vencida, já usada ou de outra ação: recusa.
- Com a chave certa: funciona.
- A chave nunca aparece na resposta nem na auditoria.
- Mutação: aceitar a chave de outra ação.

### C3. Google com retorno automático (pergunta 3, desvios 3 e 4)

**O que a documentação do Google diz** (conferido em 27/11):
- **Retorno de cliente "Aplicativo da Web":** precisa ser HTTPS, não pode ser IP e precisa bater exatamente com o endereço cadastrado.
- **Domínio do retorno:** precisa estar em "Domínios autorizados" da tela de consentimento, e o Google pede para verificar a posse desses domínios.
  - Para o app em **Teste**, a verificação não é exigida.
  - O `.ts.net` é um sufixo público, então o "domínio" seria o nome da tailnet (`<tailnet>.ts.net`). A documentação não diz se o console aceita isso.
- **App em "Teste":** a autorização vence em **7 dias**. É por isso que a reautorização se repete; com o retorno automático ela fica mais fácil, mas continua a cada 7 dias.

**Passos:**
1. **Teste no console (o Braga faz, uns 10 minutos):**
   - criar um cliente "Aplicativo da Web";
   - cadastrar o retorno `https://notebook-yui.<tailnet>.ts.net:3939/v1/admin/google/retorno`, o mesmo endereço do painel pelo Tailscale;
   - ver se o console aceita o endereço e o domínio autorizado.
   - O segredo do cliente novo entra pelo cofre do painel, como segredo. Eu nunca vejo.
2. **Se aceitar:** a rota de retorno `GET /v1/admin/google/retorno`. Ela não usa o Bearer, porque é o Google que redireciona o navegador.
   - A tentativa se confere pelo `state`: aleatório, uma vez só, 10 minutos, ligado à sessão que começou, e só depois da chave da C2.
   - PKCE como hoje. O código só se troca no servidor, e nada volta para o navegador além de "pronto, pode voltar ao painel".
   - O fluxo de colar o endereço sai do painel e fica só no script.
3. **Se não aceitar:** a Liz prefere um domínio próprio, que tem custo e configuração. A outra saída é manter a reautorização pelo script a cada 7 dias. O fluxo de colar não se publica, porque a Liz não aprova.

**Primeira conexão pelo painel** (pedido do Braga de 19/11: configurar o Google pelo painel, e não pelo `.env` nem pelo script). Hoje o painel só **renova**. Sem a autorização feita antes pelo script, ele responde "a primeira vez é pelo script" (`reautorizar.js`, código `sem-arquivo`). Com o cliente "Aplicativo da Web" aceito no passo 1:
- a chave do cliente entra pelo cofre do painel:
  - o ID do cliente, como texto;
  - o segredo do cliente, como segredo (só entra e nunca volta; protegido no disco como os outros segredos do cofre);
- o botão vira "Conectar o Google" quando ainda não há autorização, e "Reautorizar" quando há;
- o mesmo fluxo (chave da C2, `state`, PKCE e retorno automático) cria a autorização do zero, já com a conta mostrada pelo `openid email`;
- o script continua existindo como alternativa (e para o Gmail).

Testes: conectar sem autorização anterior; o segredo do cliente nunca aparece na resposta, no log nem na auditoria; ID ou segredo do cliente ausente, ou ID com formato errado, dá uma mensagem clara antes de abrir o Google; o segredo errado só aparece na troca do código (não dá para conferir sem o Google), também com mensagem clara.

**Escopos:**
- Entra `openid email` (pergunta 4), para mostrar qual conta está ligada.
  - O ID token chega direto do Google pelo HTTPS da troca.
  - Guardar o `sub` e mostrar o e-mail só com `email_verified`.
  - O e-mail nunca serve para identificar o dono da Yui.
- Isso não muda os 7 dias, porque Agenda e Tarefas continuam no pedido.

**Gmail:**
- O backend já trava por chave e rota privada, e nada mostra o Gmail como ligado sem a chave.
- A Liz quer o Gmail "bloqueado". Hoje ele está **travado**, com `YUI_GOOGLE_GMAIL` desligada, pela decisão de 19/11.
- Manter o portão ou remover o código do Gmail é decisão do Braga (decisão 5).

**Testes:**
- `state` errado, vencido ou repetido; retorno sem tentativa aberta; escopos parciais.
- Nenhum token, código ou segredo na resposta, no log ou na auditoria.
- O ID token sem `email_verified` não mostra o e-mail.

### C4. Limite de imagem único (desvio 6)

**Mudança:**
- O cérebro deixa de contar.
- O bot conta no pedido `imagem.gerar`, com a mesma `takeImageQuota` do Discord. O cérebro passa quem pediu e se é o dono.
- Com o limite estourado, o bot devolve quantos minutos faltam e nada é gerado.
- O pedido continua sem tradução, como a Liz aprovou.

**Inventário:** conferir os outros limites que contam separado por interface. Por exemplo, o orçamento de pesquisa e os limites de IA da API contra a fila do Discord. O que contar separado entra numa lista para a Liz, sem mudar nesta rodada.

**Testes:** 6 imagens pelo Discord mais 1 pelo app na mesma hora dão recusa; o dono não tem limite. Mutação: voltar a contar no cérebro.

### C5. Conflito de edição no cofre (sugestão da Liz)

- A tela do painel e o painel do Discord mandam a hora de alteração (`alteradoEm`) que viram.
- Se a chave mudou depois, a gravação é recusada com 409: "esse ajuste mudou enquanto você editava; confira e salve de novo". Nada é sobrescrito sem ninguém ver.
- **Testes:** duas edições da mesma chave a partir da mesma leitura, a segunda recusada; chaves diferentes passam.

### C6. Auditoria e repetição (desvio 5)

- Um teste percorre todas as rotas de escrita do painel e confere três coisas:
  - cada uma tem o evento de auditoria, sem conteúdo;
  - cada uma confere o dono no próprio serviço, não só no `PANEL_ACTIONS`;
  - as que mudam algo têm limite de repetição ou são idempotentes.
- O que faltar entra na mesma rodada.
- Sair da live continua sem limite, de propósito.

## O que fica como está (a Liz aprovou)

- **Desvio 3:** concessão parcial do Google. Já se gravam só os escopos devolvidos.
- **Desvio 4:** a perda do Gmail ao reautorizar.
- **Desvio 5:** as ações que vivem no cérebro. A C6 prova a autorização no serviço.
- **Desvio 7:** o semanal republicado. Conferir que a fonte aparece e que nada sai duplicado, coberto pelo limite de 10 minutos.
- **Desvio 8:** o que ficou de fora.
- **Item 9:** o GTA.
- **Prompt, prefixo e nome:** ficam para um desenho próprio. A sugestão da Liz é a base:
  - regras de segurança fixas no código;
  - personalidade editável, com versões, comparação e restaurar;
  - o prefixo por servidor;
  - nada de reiniciar sozinho.
- **O `.env` de desenvolvimento:** aquele processo não gravou nada. Seguem as regras de nunca carregar módulos da raiz com `node -e` nos agentes e de nunca ler o `.env`.

## Ordem sugerida

| Passo | O quê | Depende de |
|---|---|---|
| 1 | C4, C5 e C6 | nada (pequenas) |
| 2 | C1 | decisão 1 |
| 3 | C2 | decisão 2 |
| 4 | C3 | o teste do Braga no console (decisão 3) e a C2 |
| 5 | Bateria completa (`test:ci`), app, mutações, testes de quem não é o dono e conferência do diff | tudo acima |
| 6 | Relatório curto à Liz, OK do Braga e publicação depois das lives | passo 5 |

Todas as chaves novas continuam desligadas até o OK final, como a Liz pediu.

## Decisões que ficam com o Braga

1. **Plano com pesquisa na web:** aprovar só pela DM (recomendado) ou mostrar a consulta no painel?
2. **Confirmação reforçada:** chave pela DM só para aprovar plano e reautorizar o Google (recomendado), ou para todas as ações?
3. **Google:** fazer o teste do cliente "Aplicativo da Web" com o endereço `.ts.net` no console (é ele que libera conectar e renovar tudo pelo painel). Se não for aceito: domínio próprio, ou seguir pelo script a cada 7 dias?
4. **Somente leitura:** manter a reautorização negada com `YUI_READ_ONLY=true` (recomendado) ou abrir a exceção que a Liz pediu?
5. **Gmail:** manter o portão atual (chave e rota privada; recomendado) ou remover o código do Gmail?

## Parecer da Liz sobre este complemento (27/11/2026)

**Parecer:** favorável. C1, C2, C4, C5 e C6 aprovadas; a C3 aprovada com ajustes, inclusive a primeira conexão pelo painel com o ID e o segredo do cliente no cofre. As recomendações dela nas 5 decisões são as mesmas deste documento. A publicação continua não autorizada até o OK do Braga.

**Requisitos que ela acrescentou:**
- **C1:**
  - o resumo sai do mesmo plano guardado que será executado;
  - o hash é conferido logo antes de executar;
  - a aprovação vale uma vez só;
  - recusar pelo painel continua sempre possível.
- **C2:**
  - a chave é gerada por `crypto` e só o hash dela fica guardado;
  - o consumo é atômico e de uso único;
  - a chave fica ligada ao dono, à sessão, à ação e ao alvo, e cai junto quando a sessão vence;
  - o limite de tentativas é contado no servidor;
  - as mensagens de erro não revelam nada a mais;
  - **também vale para gravar ou trocar o ID e o segredo do cliente do Google.**
  - Ela lembra que a chave é uma confirmação ligada à operação, não um segundo fator independente: ela usa o mesmo Discord.
- **C3:**
  1. **Configuração atômica:** o ID e o segredo do cliente precisam estar os dois presentes, da mesma versão do cofre, para começar.
  2. **Validação antes de abrir o Google:** campo vazio ou ID com formato errado não começam. Não dá para prometer que o segredo errado será detectado antes da troca do código.
  3. **A tentativa fica ligada** ao dono, à sessão, à chave da C2, ao ID e à versão do cliente, ao `state`, ao PKCE e ao prazo. Se o cliente mudar no meio, a tentativa cai.
  4. **Retorno sem Bearer, mas não sem autorização:** só um `state` válido é aceito. O código se troca no servidor, e nada (código, token ou segredo) vai para o painel no redirecionamento.
  5. **Identidade da conta:** conferir a assinatura, o emissor, a audiência, a validade e o `nonce` do ID token; guardar o `sub`; mostrar o e-mail só com `email_verified`.
  - **Script e painel:** documentar como os dois dividem as credenciais. Uma autorização é do cliente que a criou: não renovar com outro cliente sem uma estratégia explícita. A preferência dela é o script usar a mesma configuração protegida; se o cliente for separado, guardar tudo separado.
  - **Os 7 dias:** o retorno automático não resolve o limite do modo Teste. Para uso contínuo, avaliar a publicação da tela de consentimento e o que o Google exige para isso.
  - **Gmail:** continua fora do painel, e a primeira conexão nunca vale como autorização para ele.
- **C4:** conferir se reiniciar o bot zera o limite. Hoje zera, de propósito: o limite vive na memória e só protege a cota dos provedores (`imageIntent.js`). Manter isso e escrever no documento, ou guardar a contagem em disco, fica para decidir na implementação. O inventário dos outros limites é só documental.
- **C5:** um **número de versão** que só cresce, em vez da hora de alteração, com gravação atômica.
- **C6:**
  - a auditoria separa negada, aprovada, concluída e concluída em parte, sempre sem conteúdo;
  - sair da live é idempotente (sair de novo não faz nada).

**Ordem:** a mesma, com uma mudança. O Braga faz o teste do Google no console **antes** de eu começar a C3.

## Andamento (27/11/2026)

**C4, C5 e C6 implementadas**, sem commit, todas as chaves como estavam. C1, C2 e C3 ainda não; a C3 espera o teste do Braga no console do Google.

- **C4, limite de imagem único:** com o cérebro separado, o cérebro pergunta ao bot pelo canal (método `imagem.cota`), e o bot conta com a mesma `takeImageQuota` do Discord. Só vai o ID: quem é o dono e qual é o limite o bot decide. Bot fora ou resposta estranha dá "indisponível" sem gerar. No processo único continua a mesma memória. Testes em `test:imagemapp` (44), com 2 mutações. Ficou como estava, e escrito no código: reiniciar o bot zera a contagem, que vive na memória e só protege a cota dos provedores.
- **C5, versão por ajuste no cofre:** `versoes` no arquivo, um número por chave que só cresce (gravar e tirar sobem; tirar não zera). O `PUT` e o `DELETE` de `/v1/admin/config` aceitam `versao`: a errada dá 409 "mudou enquanto você editava" e nada muda, a inválida dá 400, e sem versão grava como antes. A conferência e a gravação acontecem no mesmo passo síncrono.
  - O painel web manda a versão que viu e recarrega a tela no 409.
  - O painel do Discord leva a versão no fim do identificador dos botões e do formulário (`~v<n>`), inclusive na tela de confirmação. O formulário "Modelos & Pensamento" leva as 3 versões; a chave que mudou no meio é recusada e as outras gravam.
  - Pelo canal, o cérebro repassa a versão.
  - Testes em `test:painelia` (29) e no app (`guild-logic`), com 3 mutações.
- **C6, auditoria e repetição:**
  - **Auditoria da negada:** toda tentativa negada de uma rota de escrita do painel vira `admin.negado`, só com a ação da matriz e o código HTTP.
  - **Freio de pedido repetido:** vale para as ações que não são idempotentes (criar e adiar lembrete, resumo do dia, reiniciar, testar provedor e o tocar do rádio). O mesmo pedido do dono, enquanto o primeiro roda ou até 5 s depois que ele deu certo, dá 429, e nada é feito de novo. Um pedido que falhou não segura o próximo, e quem não é o dono recebe o 403 de sempre.
  - **Ficam sem freio, de propósito:**
    - seguir canal, banir e cadastrar chave ou provedor de IA, que já recusam a duplicata;
    - pular faixa;
    - iniciar o rádio, que já recusa o segundo início;
    - sair da live, que é idempotente.
  - **Suíte nova `test:painelescritas` (12):**
    - inventário de todas as rotas de escrita, com a classe de cada uma; rota nova sem classe faz o teste falhar;
    - dono conferido no próprio serviço (membro chamando direto recebe 403);
    - auditoria da concluída e da negada;
    - o freio.
  - 4 mutações.
  - Quatro suítes antigas repetiam o mesmo pedido em cenários seguidos. Elas passaram a usar um relógio de teste que anda um minuto por pedido.
- **Bateria completa:** `test:ci` 123/123 (com a suíte nova). App: `tsc` limpo, painel recompilado (carimbo b34f8a85d83d), `npm test` 177/177.

**C1 implementada (27/11/2026, fim da manhã)**, sem commit. A decisão 1 foi aplicada como recomendado: plano com pesquisa só se aprova pela DM. O Braga ainda pode mudar.
- **O resumo:** montado em `src/core/planos/ferramentas.js` (`resumoSeguroDoPasso`) a partir do passo guardado, o mesmo que será executado. Cada ferramenta declara `servico`, `saida` e, se tem texto livre, `fraseSegura`. O texto livre é qualquer parâmetro de texto sem lista fechada. Sem texto livre, a ação é a própria frase do plano (só valores fechados); com ele, a frase segura e o tamanho.
- **Na vista dos planos:** `passos[].resumo` (lista fechada de campos, conferida de novo na vista) e `aprovarSoPelaDm`, que olha todos os passos.
- **Na decisão:** a `decidir()` do serviço, com origem "painel", responde `so-pela-dm` quando algum passo manda texto da pessoa para fora (ou não pode ser resumido). A auditoria registra `plan.panel_blocked`, o admin responde 409 e o plano segue aguardando. Recusar pelo painel e aprovar pela DM continuam como antes.
- **No app:** cada passo mostra a ação e o detalhe (serviço · só leitura · para onde vai · "nome buscado: N caracteres (o texto está na DM)"). No plano com pesquisa, o Aprovar dá lugar ao aviso "aprove pela DM", e o Recusar fica.
- **Testes:** `test:painelleituras` (21), `test:painelacoes` (29) e o app (`planos-logic`, 14), com 4 mutações. Bateria: `test:ci` 123/123; app 179/179; painel recompilado (carimbo 91839e0ef150).

**C2 implementada (27/11/2026, ~12h)**, sem commit. A decisão 2 foi aplicada como recomendado: a chave pela DM só para aprovar plano e reautorizar o Google.
- **O módulo `src/core/api/confirmacao.js`:**
  - 6 dígitos (`crypto.randomInt`); só o hash fica guardado, na memória do processo da API;
  - uso único, conferido e consumido no mesmo passo síncrono;
  - presa ao dono, à sessão do painel, à ação e ao alvo. A sessão é um resumo do Bearer, guardado num `WeakMap` ao lado do contexto congelado e marcado pelo `server.js`;
  - 5 minutos de validade; pedir outra para o mesmo alvo invalida a anterior; sair do painel leva as chaves da sessão;
  - 5 erros em 15 minutos travam por 15 minutos e avisam o dono (`lock-confirmacao`, crítico, registrado nas regras da fila de avisos);
  - 10 pedidos em 15 minutos travam os pedidos.
- **A rota `POST /v1/admin/confirmacao/pedir`** (`admin.discord_dm`): manda a chave só pela DM, com o envio de mensagem ao dono de sempre (no cérebro separado, pelo bot). Se a DM não sai, a resposta é 502 e a chave é descartada.
- **Onde a chave é exigida:** `decidirPlano` (só aprovar) e `googleReautorizarInicio` conferem `confirmacao` antes do serviço. As respostas são 428 sem chave, 422 com chave inválida ou vencida (uma frase só) e 429 quando travou.
- **Auditoria:** `admin.confirmacao.pedida`, `usada`, `recusada` e `falhou`, nunca com a chave.
- **No app:** o componente `ChaveDaDm` (campo de 6 dígitos, Confirmar, Pedir outra e Cancelar) aparece no plano depois da confirmação, e no Google antes do link. Erro da chave mantém o campo aberto.
- **Testes:** suíte nova `test:painelconfirmacao` (14). As antigas `test:painelacoes` e `test:painelgoogle` usam um substituto que aceita a chave, porque o assunto delas é outro. App: `confirmacao-logic` (4) e as telas. 4 mutações.
- **Bateria completa:** a primeira rodada deu 123/124 e pegou a chave de aviso sem regra; corrigido, a segunda deu `test:ci` **124/124**. App 183/183; painel recompilado (carimbo 38e216c8a927).

## Parecer da Liz sobre a publicação (27/11/2026, tarde)

**Parecer:** favorável à publicação do `07b534f`, com ressalvas operacionais. Ela não pede reversão. Para uma revisão conclusiva, ela pede o diff do commit.

**O que ela pediu para conferir, e o que eu conferi:**
- **C5, apagar e recriar uma chave:** a versão não reinicia. A remoção sobe a versão e a mantém no arquivo; o teste "a remoção não zera" cobre isso (gravar 1, 2; tirar 3; gravar 4). Hoje só o cérebro grava o cofre; com mais de uma instância seria preciso uma trava entre processos.
- **C2, hash e sessão:** a comparação usa `crypto.timingSafeEqual`. A sessão é o SHA-256 do Bearer com prefixo, cortado em 32 caracteres; o Bearer nunca é guardado nem registrado. Sair do painel leva as chaves (testado). A sessão vencida não autentica mais, e a chave vence em 5 minutos. Reiniciar o processo invalida as chaves pendentes, que viram vencidas.
- **C4, todos os caminhos da imagem pelo contador:** **NÃO.** O `/yui-imagem` (comando de barra) gera direto e nunca contou. A ferramenta da IA, a Porta I e o app contam. Isso já era assim antes; fica como pendência para o Braga decidir.
- **C6, volume das negadas:** o limite geral da API é de 240 pedidos por minuto por usuário, então um token de membro poderia gerar até 240 linhas `admin.negado` por minuto. A auditoria gira em 10 MB, mas vale limitar (por exemplo, uma linha por usuário, ação e código por minuto, com contagem). Pendência.
- **C1, execução com o objeto validado:** a execução lê o plano guardado e confere, a cada passo, o hash do plano e o hash dos argumentos do passo (`servico.js`). Não reconstrói nada depois da aprovação.

**Também registrado:**
- O limite de imagem vale por período de execução do bot, porque reiniciar zera a contagem.
- O freio de 5 segundos protege contra o clique duplo, não contra abuso: as operações sensíveis mantêm os limites próprios (decisões de plano, chaves, reautorização).

**As duas pendências da revisão foram corrigidas (27/11/2026, ~13h50)**, sem commit:
- **`/yui-imagem`:** conta no mesmo limite por pessoa por hora (`takeImageQuota`, na memória do bot, a mesma da conversa, da ferramenta e do app). Estourou: a frase de sempre em privado, sem gerar. O dono não tem limite. A frase virou `TEXTO_LIMITE_DE_IMAGEM` em `imageIntent.js`, e um teste confere que o despachante usa a mesma.
- **`admin.negado`:** no máximo uma linha por pessoa, ação e código por minuto. As outras são contadas e saem na próxima linha (`repetidas`).
- **Testes:** `test-interaction-limits` (63) e `test:painelescritas` (13), com uma mutação em cada. `test:ci` 124/124.
- **Visto e não mexido:** o `/yui-imagem` também pula o reforço de segurança do pedido negativo (`bypassSafety: true`), como já era. Fica para decisão do Braga.
