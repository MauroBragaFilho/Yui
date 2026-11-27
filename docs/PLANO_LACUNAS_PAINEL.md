# Plano: fechar as lacunas do painel web, por ordem de importância

Escrito em 26/11/2026 pela Alice, a pedido do Braga. Base: inventário e detalhes técnicos em [LEVANTAMENTO_LACUNAS_PAINEL.md](LEVANTAMENTO_LACUNAS_PAINEL.md) (leitura do código no `origin/main` 5c7877f). Respeita as decisões dele: tudo configurável pelo painel sem depender do `.env` (25/11), controle também por servidor e o Google primeiro (19/11), código novo desligado por chave, revisão da Liz antes de publicar o painel e nada publicado antes das lives de 28-29/11, salvo correção da live.

## Como a importância foi decidida

Na frente vem, nesta ordem:

1. o que está **errado hoje** (o painel diz que desligou e não desligou);
2. o que é a **base** de tudo o que vem depois (as chaves que só existem no `.env`);
3. o que já está **ligado em produção** sem visibilidade no painel (planos, live do YouTube);
4. os pedidos explícitos dele (Google, configuração da IA, por servidor);
5. por fim, o que é conforto (rádio completo, imagem no Chat, listas).

Esforço: **P** até meio dia, **M** cerca de um dia, **G** dois dias ou mais. Cada item sai com testes (os dois lados e uma mutação), painel recompilado (`npm run painel:build`) e `npm test` do app.

## Resumo em ordem

| # | Lacuna | Por que nessa posição | Esforço | Liz |
|---|---|---|---|---|
| 1 | O painel desliga e não vale (imagem e GTA por servidor) | É defeito: a escolha do dono é ignorada | P | relatório curto |
| 2 | As 10 chaves que só existem no `.env` | Base do "tudo pelo painel"; o cofre já suporta | P | relatório curto |
| 3 | Planos e avisos da Fase 3 | `YUI_PLANOS` e `_AUTO` estão LIGADOS e só aparecem na DM | M | sim (aprovar pelo painel) |
| 4 | YouTube Live | Vai ao ar nas lives; hoje não há estado nem cota no painel | M | sim (entrar e sair) |
| 5 | Google: estado da autorização | "Google primeiro"; o token vence a cada 7 dias em Testando | P | relatório curto |
| 6 | Configuração da IA (Painel Runtime do Discord) | Pedido dele, e hoje metade não sobrevive ao reinício | M | sim (prompt do sistema) |
| 7 | Monitores | A API já existe; falta só a tela | P | relatório curto |
| 8 | Funções por servidor numa tela só | Pedido de 19/11; reaproveita as ferramentas por servidor | M | sim |
| 9 | GTA: o que saiu, estado e republicar | Muito usado nos servidores; hoje é só no Discord | M | sim (republicar) |
| 10 | Rádio completo | Iniciar, pular, fila e gênero | M | relatório curto |
| 11 | Imagem no Chat do app | Princípio 9 (toda função também por conversa) | G | sim |
| 12 | Listas, skills e continuidade (só ver) | Transparência do que a Yui guarda | P cada | relatório curto |
| 13 | Aba Código | Sem tela desde 11/11; decidir remover ou voltar | P | — |
| 14 | Google: reautorizar pelo painel | Acaba com o script no PC, mas mexe com credencial | G | sim, desenho antes |

## Os itens

### 1. O painel desliga e não vale (defeito)

**O que acontece hoje.** Desligar a ferramenta de imagem ou de GTA no servidor não tem efeito em dois caminhos:
- o `/yui-imagem` não chama `isToolDisabled` (`src/discord/events/interactionCreate.js:824-832`);
- a pré-rota de GTA (Porta G) não confere `gta_online` (`src/handlers/llmHandler.js:2831`).

A Porta I e a pesquisa já respeitam.

**O que fazer:**
- Consultar `isToolDisabled(guildId, tool)` nos dois caminhos, com a mesma frase das outras recusas.
- Varrer as outras entradas das ferramentas alternáveis (downloads, buscar jogo, Steam, moeda, lembretes, voz) atrás do mesmo furo.

**Pronto quando:** cada ferramenta desligada no servidor é recusada em todos os caminhos (comando, menção e conversa), com teste dos dois lados, e a DM continua igual.

### 2. As 10 chaves que só existem no `.env`

**O que fazer:** levar para o cofre (`src/core/painelConfig.js`, uma linha por item, mais teste e documentação) as chaves abaixo.

| Chave | Vale quando | Confirmação |
|---|---|---|
| `GTA_WEEKLY_ENABLED` | ao reiniciar | — |
| `NEWSWIRE_ENABLED` | ao reiniciar | — |
| `REQUIRE_TOS` | ao reiniciar | para desligar |
| `YUI_RESEARCH_ENABLED` | a confirmar | — |
| `YUI_MEMORY_ENABLED` | a cada uso | para desligar |
| `YUI_LISTS_ENABLED` | a cada uso | — |
| `YUI_REMINDERS_ENABLED` | a cada uso | — |
| `YUI_VISION` | a cada uso | — |
| `YUI_AUTOMOD_AI_BAN` | a cada uso | para `auto` |
| `YUI_HEALTH_REPORT` | a cada uso | — |

**Cuidados:**
- Só marcar `reinicio:false` depois de conferir que todo consumidor, nos **dois** processos, lê a chave a cada uso. Na dúvida, fica `reinicio:true`.
- Não entra no cofre nada da lista do que o painel nunca controla (item "Regras" abaixo).

**Pronto quando:** as 10 chaves aparecem em Configuração e chaves, com o grupo certo e os testes do cofre passando.

### 3. Planos e avisos da Fase 3

**Hoje:** os planos estão ligados em produção, com aprovação automática, e só aparecem na DM. A fila de avisos está em modo observar e não aparece no painel.

**O que fazer:**
- **v1 (só ver):** rotas novas `GET /v1/admin/planos` (lendo `src/core/planos/store.js`) e `GET /v1/admin/avisos` (lendo `src/core/avisos/fila.js`, incluindo as linhas do modo observar). Tela "Planos e avisos" no Admin, grupo Operação, com os últimos planos, o estado, o que foi executado e quando, e os avisos adiados ou que seriam adiados.
- **v2 (controlar):** aprovar ou recusar um plano pelo painel. É um canal novo de aprovação: precisa de desenho com a Liz (mesmas regras da DM, uso único, prazo e auditoria) e de rota no `ROUTES` do `routeGuard` e no `PANEL_ACTIONS`.

**Pronto quando:** o dono vê pelo painel cada plano criado e executado e cada aviso adiado, sem precisar abrir a DM.

### 4. YouTube Live

**O que fazer:**
- **v1 (só ver):** `GET /v1/admin/live` a partir de `estado()` em `src/core/live/servico.js:174`. Cartão "Live do YouTube" no Início (só quando ligado) e detalhe em Integrações: em qual live está, desde quando, mensagens lidas e respondidas, cota do dia e último erro (sem o texto das mensagens).
- **v2 (controlar):** entrar e sair da live pelo painel, com o mesmo ritmo e duração do comando por conversa, via `PANEL_ACTIONS`, `routeGuard` e auditoria.

**Quando:** a v1 serve de apoio às lives. Se o Braga quiser antes de 28/11, entra como "correção da live"; se não, logo depois.

### 5. Google: estado da autorização

**O que fazer:**
- `GET /v1/admin/google` a partir de `estado()` em `src/integrations/google/google.js:193`: ligado ou não, escopos concedidos (só os nomes), validade do token, última renovação e último erro.
- Item "Google" em Integrações (`src/core/api/integrations.js`).
- Aviso no Início quando faltar menos de 2 dias para vencer ou a renovação falhar.

**Cuidado:** a rota nunca devolve token nem client secret.

**Pronto quando:** o painel mostra que o token vence em X dias e acusa a falha de renovação antes de a Agenda parar.

### 6. Configuração da IA (o Painel Runtime do Discord)

**Hoje está quebrado, além de estar só no Discord:**
- As 20 opções "runtime" (temperatura, timeout, max_tokens, top_p por provedor, mostrar modelo, retentativas) ficam só na memória do bot e somem ao reiniciar.
- As 20 opções "json" (modelos, URLs, prompt do sistema, prefixo, nome, `requireTos` etc.) são gravadas em `src/config/config.json`, mas esse arquivo não é lido ao subir (`configPanelHandler.js:523-525`). O `.env` vence.

**O que fazer:**
1. Levar para o cofre, como fonte única, o que faz sentido: modelos, temperatura, timeout, max_tokens e top_p por provedor, mostrar modelo e retentativas. Grupo "IA" ou a aba IA existente.
2. Fazer o bot e o cérebro lerem do cofre. Conferir se o cérebro usa os `providerSettings`, o que ainda não foi confirmado.
3. Prompt do sistema e prefixo: só com desenho da Liz, porque mexe na persona e na segurança.
4. O painel do Discord passa a gravar no mesmo cofre ou é aposentado, com aviso, para não haver duas fontes.

**Pronto quando:** uma mudança feita pelo painel vale na Yui, sobrevive ao reinício e aparece igual no Discord.

### 7. Monitores

**O que fazer:** chamar no `client.ts` as rotas que já existem (`GET /v1/admin/monitores` e `DELETE /v1/admin/monitores/:id`, esta já no `routeGuard`). Tela "Monitores" no Admin, grupo Operação:
- lista com assunto (até 60 caracteres), estado, próxima checagem, data de fim e avisos enviados;
- botão "Cancelar", com confirmação;
- aviso quando `YUI_MONITORES` estiver desligado.

**Pronto quando:** o dono vê e cancela pelo painel os monitores criados pela conversa.

### 8. Funções por servidor numa tela só

**O que fazer:**
- Na tela do servidor, uma aba "Funções" com um interruptor por função: imagem, pesquisa, GTA pela conversa, downloads, buscar jogo, Steam, moeda, lembretes e voz. Ela reaproveita `server_tools.json` e as rotas de ferramentas que já existem.
- GTA agendado (diário, semanal, notícias) continua sendo por canal, mas aparece na mesma tela, com atalho para os canais.
- Funções globais que devem ganhar versão por servidor (pesquisa direta, persona) entram uma a uma, com desenho da Liz.

**Depende do item 1:** sem ele, o interruptor promete o que não cumpre.

### 9. GTA: o que saiu, estado e republicar

**O que fazer:**
- **v1 (só ver):** rota `GET /v1/admin/gta` com o último diário (`getLatestDaily`, `dailyRepo.js:12`), o último semanal válido (`getLatestValidWeekly`, `weeklyRepo.js:20`), a última notícia e onde foi publicada (`publicationRepo.getPublished`). Tela "GTA" no Admin, com estado das fontes e erros (Reddit desligado aparece como desligado, não como erro).
- **v2 (controlar):** republicar num servidor ou canal, com confirmação, `PANEL_ACTIONS` e `routeGuard`. Ligar e desligar o semanal e o Newswire já chega com o item 2.

### 10. Rádio completo

**O que fazer:**
- **Iniciar:** variante de `startRadioMode` que receba `voiceChannelId` e `textChannelId` em vez de exigir alguém na call (`radioManager.js:93`, `createSession` em `radioDatabase.js:76`). O painel lista os canais de voz do servidor.
- **Pular:** `nextTrack` mais `playTrack` (`radioMCPHandler.js:151-159`).
- **Gênero ou música:** `resolveInput` (`radioMCPHandler.js:48-60`). Quando o resultado é ambíguo, o painel mostra as opções.
- **Fila:** ver as próximas faixas.
- Novas ações em `RADIO_ACTIONS` e `defaultRadioDeps`, e na `routeGuard`.

### 11. Imagem no Chat do app

**O que fazer:**
1. `registerTool` de imagem em `src/core/agent/tools.js`, com a política de acesso e o limite `YUI_IMAGE_PER_HOUR`.
2. Pré-rota em `preRotas.js`, como a Porta I (princípio 9).
3. Campo de imagem na resposta do `/v1/agent`, servido pelo link curto (`server.js:266-271`).
4. Exibir a imagem no `ChatScreen`.
5. Linha no `routeGuard` e na matriz de permissões.

**Conferir antes:** se o `generateImage` (`src/handlers/imageHandler.js:307`) roda no cérebro.

**Depois:** downloads e buscar jogo pelo Chat do app, no mesmo molde.

### 12. Listas, skills e continuidade (só ver)

Rotas de leitura, só do dono e sem conteúdo de terceiros, e uma tela cada:
- **Listas pessoais:** as listas e os itens do dono.
- **Skills:** catálogo instalado e permitidas (`carregarCatalogo`, `carregador.js:218`). Ligar e desligar cada skill fica para uma v2 com a Liz.
- **Continuidade:** projetos e decisões registrados, com a opção de apagar (com confirmação).

### 13. Aba Código

As variáveis `YUI_DEV_*` existem, mas a tela saiu em 11/11. Decidir com o Braga entre:
- remover os restos (rotas `/v1/dev` sem uso e a documentação);
- trazer a tela de volta com a regra da aprovação local.

### 14. Google: reautorizar pelo painel

Trocar o `scripts/google-autorizar.mjs` por um fluxo OAuth iniciado no painel: redirecionamento para o endereço do Tailscale, `state` de uso único, token gravado só no servidor e nunca devolvido.

Mexe com credencial e com o console do Google (URI de redirecionamento), por isso **desenho com a Liz antes de qualquer código**. Enquanto isso, o item 5 cobre a visibilidade.

## Regras que valem para todos os itens

- **Só o dono, sempre auditado.** Toda rota é só do dono. Toda rota de escrita entra no `ROUTES` de `src/core/security/routeGuard.js` e, com o cérebro separado, no `PANEL_ACTIONS` de `src/cerebro/painel.js`. A auditoria registra a ação, nunca o conteúdo.
- **O que o painel nunca controla:**
  - modo somente leitura, senha e sessão do painel, tokens e o token do Discord, dono e políticas de segurança;
  - liberar a rota privada (o painel só pede a verificação), Gmail, retenção da memória, caminhos de arquivo e comandos;
  - segredo só entra; banir o dono;
  - `YUI_PAINEL_CONFIG_EDIT=false` e `YUI_PANEL_AI_EDIT=false` continuam travando a edição.
- **Recursos novos nascem desligados ou só de leitura.** Ações (aprovar, republicar, entrar na live, iniciar rádio, gerar imagem) vêm numa v2 com desenho da Liz.
- **Testes:** cada lógica de tela fica em arquivo `*Logic.ts`, com teste em `apps/yui-app/tests`. Cada rota nova tem teste do servidor: dono x não dono e o que nunca sai na resposta.
- **Publicação:** uma entrega por vez, com relatório à Liz antes. Nada sai antes das lives de 28-29/11, salvo o que ele pedir como apoio à live.

## Entregas sugeridas

| Entrega | Itens | Por quê junto | Quando |
|---|---|---|---|
| A | 1, 2, 7 | Defeito, base e a tela que já tem API: pequenas, de baixo risco | logo depois das lives |
| B | 4 v1, 5, 3 v1 | Tudo só leitura e ligado ao que está em produção (live, Google, planos) | 4 v1 antes da live, se ele pedir; o resto depois |
| C | 6 | Configuração da IA, com o conserto da persistência; precisa de revisão própria | depois da B |
| D | 8, 9 v1, 12 | Visão por servidor e transparência | depois da C |
| E | 3 v2, 4 v2, 9 v2, 10 | As ações, com desenho da Liz | depois do desenho |
| F | 11, 13, 14 | Maiores ou que dependem de decisão | quando houver espaço |

## Decisões que ficam com o Braga

1. Quer o cartão da live (4 v1) antes das lives de 28/11, como apoio, ou depois?
2. Aprovar planos pelo painel (3 v2), ou mantém a aprovação só pela DM?
3. O painel de configuração do Discord: aposentar (o painel web vira a única fonte) ou manter gravando no mesmo cofre?
4. Aba Código: remover os restos ou trazer de volta?
5. Reautorizar o Google pelo painel (14) vale o trabalho, ou segue pelo script a cada 7 dias até publicar o app do Google?

## Complemento (27/11/2026)

As entregas A a F foram implementadas, e a Liz deu parecer favorável com ressalvas. As correções que ela pediu antes de publicar estão em [PLANO_LACUNAS_PAINEL_CORRECOES.md](PLANO_LACUNAS_PAINEL_CORRECOES.md), com 5 decisões para o Braga.
