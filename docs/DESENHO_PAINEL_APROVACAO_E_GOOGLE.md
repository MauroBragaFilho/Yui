# Desenho: aprovar planos e reautorizar o Google pelo painel

Escrito em 26/11/2026 pela Alice para o parecer da Liz. É parte do [PLANO_LACUNAS_PAINEL.md](PLANO_LACUNAS_PAINEL.md) (itens 3 v2 e 14). O Braga decidiu em 26/11: **ver e aprovar planos pelo painel** e **reautorizar o Google pelo painel**. O código nasce desligado e só é publicado com o parecer da Liz e o OK dele.

## 1. Aprovar e recusar planos pelo painel

### Hoje

O serviço de planos (`src/core/planos/servico.js`, no cérebro) já tem uma decisão única, `decidir({ userId, id, versao, hash, aprovar })`, usada pelos botões da DM via o canal (`src/cerebro/planos.js:20`). Ela já confere, nesta ordem:

1. planos ligados;
2. quem decide é o dono;
3. o plano existe e é dessa pessoa, com a mesma versão e o mesmo hash (prefixo de 16 ou mais);
4. o estado é "aguardando";
5. a validade (30 min) não venceu;
6. o hash recalculado bate (nada mudou desde a criação).

Depois, a decisão grava o estado antes de executar, então um segundo clique encontra o plano já aprovado.

### Proposta

- **Leitura:** `GET /v1/admin/planos`, só do dono. Lista os últimos planos (até 20) com id, versão, prefixo do hash (16), estado, criado em, validade, os passos (nome da ferramenta e estado de cada um, **sem os argumentos nem os resultados**) e o motivo do encerramento.
- **Decisão:** `POST /v1/admin/planos/:id/decisao` com `{ versao, hash, aprovar }`, que chama **a mesma** `decidir()` com o `userId` da sessão do painel. Nenhuma regra nova e nenhum atalho: se valer na DM, vale no painel; se não valer, também não.
- **Segurança da rota:** entra no `ROUTES` do `src/core/security/routeGuard.js` e no `PANEL_ACTIONS` de `src/cerebro/painel.js` (no modo de cérebro separado, a API já roda no cérebro).
- **Auditoria:** os mesmos eventos `plan.approved` e `plan.rejected`, com a origem `painel`, sem conteúdo.
- **Na tela:**
  - o plano aguardando mostra os passos legíveis (o mesmo texto da DM, montado por código) e dois botões, Aprovar e Recusar;
  - aprovar pede confirmação ("Executar estes N passos de leitura?");
  - depois de decidido, os botões somem e a DM passa a responder "Esse plano já foi respondido".
- **Chave:** `YUI_PLANOS_PAINEL=false` (cofre, só o dono). Desligada, a rota de decisão responde 404 e a tela mostra só a leitura.

### Riscos e respostas

| Risco | Resposta |
|---|---|
| Sessão do painel roubada aprova um plano | Os planos só fazem **leitura** (a matriz dos planos já impõe isso), exigem o hash e a versão atuais, valem 30 min e a sessão do painel é só do dono, pelo Tailscale. A chave permite desligar. |
| Dois cliques (DM e painel) | A `decidir()` grava "aprovado" de forma síncrona antes de executar; o segundo clique recebe "já foi respondido". |
| Plano trocado entre ver e aprovar | O hash e a versão vão no pedido; qualquer diferença recusa. |

## 2. Reautorizar o Google pelo painel

### Hoje

O token só é criado pelo `scripts/google-autorizar.mjs`, num PC com navegador:

- o cliente é do tipo "App para computador", e o retorno vai para `http://127.0.0.1:<porta>`;
- o fluxo usa PKCE S256 e `state`;
- o arquivo de token (`secrets/google-token.json`, permissão restrita) guarda `client_id`, `client_secret`, `refresh_token` e os escopos;
- em modo Testando, o refresh token vence a cada 7 dias.

### Limitação

Esse tipo de cliente só aceita retorno em 127.0.0.1. Quando o fluxo começa pelo painel, o retorno vai para o 127.0.0.1 **do aparelho do Braga**, não do notebook. Trocar para um cliente "Aplicativo da Web", com retorno no endereço `.ts.net`, exigiria mudar o console do Google e confirmar que o Google aceita esse domínio. Evitamos.

### Proposta: o mesmo fluxo, com o endereço colado de volta

1. **Início.** Com a chave `YUI_GOOGLE_REAUTORIZAR_PAINEL=true` e já existindo um arquivo de token, o dono clica em "Reautorizar o Google" em Integrações. O servidor:
   - lê o `client_id` do arquivo existente;
   - gera o PKCE (verificador só na memória do servidor) e um `state` aleatório;
   - fixa o retorno em `http://127.0.0.1:<porta fixa>`;
   - devolve só o **link de consentimento**.
   - A sessão de autorização vale 10 min, é uma por vez e só para o dono.
2. **Consentimento.** O Braga abre o link, entra e autoriza. O navegador vai para `127.0.0.1` e mostra erro de página ("não foi possível conectar"), o que é esperado. A barra de endereço tem `?code=...&state=...`.
3. **Retorno.** Ele cola esse endereço inteiro no painel. O servidor:
   - confere o `state` em tempo constante e a validade;
   - troca o código pelos tokens com o verificador (o código usa a `trocarCodigoPorTokens` que já existe, `src/integrations/google/troca.js`);
   - confere os escopos;
   - grava o arquivo pelo caminho atômico de sempre (`gravarArquivoDeToken`, permissão restrita).
   - A sessão de autorização é apagada **na primeira tentativa**, certa ou errada (uso único).
4. **Volta a funcionar.** O arquivo novo não tem a marca de "precisa autorizar", então a integração volta sozinha (comportamento atual do `auth.js`).

### Regras

- **Escopos:** só Agenda e Tarefas, somente leitura. **O Gmail nunca entra pelo painel** (`painelConfig.js:7-9`). Se o arquivo atual tiver o Gmail, a reautorização pelo painel não o pede e avisa que o Gmail fica para o script.
- **Nada volta à tela:** nem token, nem `client_secret`, nem código, nem corpo de resposta do Google. A rota devolve só o link e depois "autorizado até <data>" ou um código fixo de erro.
- **Sem arquivo de token** (primeira vez), o painel não faz nada e manda usar o script. O upload do JSON do cliente fica para depois, se ele pedir.
- **Rotas e auditoria:** `POST /v1/admin/google/autorizar/inicio` e `POST /v1/admin/google/autorizar/retorno` (corpo `{ endereco }`), no `ROUTES` do `routeGuard` e no `PANEL_ACTIONS`, só do dono. A auditoria registra `google.reauth.start`, `google.reauth.ok` e `google.reauth.fail` com o código, sem conteúdo.
- **Limite:** 5 tentativas por hora.
- **Estado:** `GET /v1/admin/google` (item 5 do plano) mostra validade, escopos, última renovação e último erro, também sem segredo.

### Riscos e respostas

| Risco | Resposta |
|---|---|
| O código de autorização passa pelo painel | Vai por HTTPS dentro da tailnet, vale uma vez, fica preso ao PKCE (sem o verificador, que nunca sai do servidor, não serve) e ao `state`, e a sessão dura 10 min. |
| Um endereço colado de outra autorização | O `state` não bate e a tentativa é recusada. |
| Troca da conta Google | O arquivo novo é de quem autorizou. A tela mostra a conta (o e-mail vem do `id_token`, só se houver o escopo; senão, "conta não informada"). Pergunta à Liz: vale pedir `openid email` para mostrar a conta? |
| Painel com o cérebro fora | A rota falha fechada. Nada é gravado sem a troca completa. |

## Perguntas para a Liz

1. Aprovação pelo painel com a mesma `decidir()`: há algum requisito extra para a origem `painel`, como reautenticar ou exigir sessão nova?
2. O "colar o endereço" é aceitável, ou ela prefere o cliente "Aplicativo da Web" com retorno no `.ts.net`?
3. Pedir `openid email` só para mostrar qual conta autorizou?
